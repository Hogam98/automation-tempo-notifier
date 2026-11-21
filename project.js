const VALID_TEMPO_COLORS = ["BLEU", "BLANC", "ROUGE"];
const TODAY_SEND_HOUR = 8;
const TOMORROW_SEND_HOUR = 16;
const MAX_SMS_LENGTH = 480;
const DISPATCH_DELAY_MS = 1500;

const SMS_GATEWAY_REPO = "automation-sms-notifier";
const SMS_GATEWAY_WORKFLOW = "execute.yml";
const SMS_GATEWAY_REF = "main";

const DEFAULT_PRICES = {
  horaires: { hp_start: "06h", hp_end: "22h", hc_start: "22h", hc_end: "06h" },
  tarifs: {
    bleu: { hp: "0,1609", hc: "0,1296" },
    blanc: { hp: "0,1894", hc: "0,1486" },
    rouge: { hp: "0,7562", hc: "0,1568" }
  },
  quotas: { bleu: 300, blanc: 43, rouge: 22 }
};

const REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "Accept": "application/json"
};

module.exports = async function (context) {
  const dispatchToken = context.secrets.DISPATCH_TOKEN;
  const gatewayOwner = String(process.env.GITHUB_REPOSITORY_OWNER || "").trim();

  if (!dispatchToken || !gatewayOwner) {
    throw new Error('Missing required secret "DISPATCH_TOKEN" or environment variable "GITHUB_REPOSITORY_OWNER".');
  }

  const recipients = [];
  for (const [key, value] of Object.entries(context.secrets)) {
    if (key !== "SMS_TO" && !key.startsWith("SMS_TARGET_NUMBER")) {
      continue;
    }

    for (const entry of String(value || "").split(/[,;\s]+/)) {
      const phone = entry.trim();
      if (phone && !recipients.includes(phone)) {
        recipients.push(phone);
      }
    }
  }

  if (recipients.length === 0) {
    throw new Error('Missing required secret "SMS_TARGET_NUMBERS" (or "SMS_TARGET_NUMBER").');
  }

  const now = new Date();
  const parisHour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    hour: "numeric",
    hourCycle: "h23"
  }).format(now));

  const dateFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const todayDateKey = dateFormatter.format(now);
  const tomorrow = new Date(now.getTime() + 86400000);
  const tomorrowDateKey = dateFormatter.format(tomorrow);

  const periods = [];
  if (parisHour >= TODAY_SEND_HOUR && context.state.get("TEMPO_LAST_SENT", "today") !== todayDateKey) {
    periods.push({
      key: "today",
      label: "Aujourd'hui",
      endpoint: "/tempo/today",
      dateKey: todayDateKey,
      targetDate: now
    });
  }

  if (parisHour >= TOMORROW_SEND_HOUR && context.state.get("TEMPO_LAST_SENT", "tomorrow") !== tomorrowDateKey) {
    periods.push({
      key: "tomorrow",
      label: "Demain",
      endpoint: "/tempo/tomorrow",
      dateKey: tomorrowDateKey,
      targetDate: tomorrow
    });
  }

  if (periods.length === 0) {
    return;
  }

  const githubHeaders = {
    Authorization: `Bearer ${dispatchToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Automation-Tempo-Notifier"
  };

  for (const period of periods) {
    const tempoData = await context.gateway.getJson(period.endpoint, REQUEST_HEADERS);
    const upperColor = String(tempoData?.couleur || "").trim().toUpperCase();

    if (!VALID_TEMPO_COLORS.includes(upperColor)) {
      console.log(`[TempoEDF] ${period.key} color not available yet (${upperColor || "empty"}).`);
      continue;
    }

    let balanceAdjustment = 0;
    if (period.key === "today") {
      try {
        const tomorrowData = await context.gateway.getJson("/tempo/tomorrow", REQUEST_HEADERS);
        const tomorrowColor = String(tomorrowData?.couleur || "").trim().toUpperCase();
        if (VALID_TEMPO_COLORS.includes(tomorrowColor) && tomorrowColor === upperColor) {
          balanceAdjustment = 1;
        }
      } catch (e) {
        console.warn(`[TempoEDF] Unable to check tomorrow color for balance adjustment (${e.message}).`);
      }
    }

    const remainingData = await context.gateway.getJson("/tempo/remaining", REQUEST_HEADERS);
    const lowerColor = upperColor.toLowerCase();
    const { hp_start: hpStart, hp_end: hpEnd, hc_start: hcStart, hc_end: hcEnd } = DEFAULT_PRICES.horaires;
    const hpPrice = DEFAULT_PRICES.tarifs[lowerColor].hp;
    const hcPrice = DEFAULT_PRICES.tarifs[lowerColor].hc;
    const maxQuota = DEFAULT_PRICES.quotas[lowerColor];

    const rawRemaining = parseInt(remainingData?.remaining?.[upperColor], 10);
    const remainingText = !Number.isNaN(rawRemaining)
      ? `${Math.max(0, rawRemaining + balanceAdjustment)}/${maxQuota}`
      : `Indisponible/${maxQuota}`;

    const rawDate = period.targetDate.toLocaleDateString("fr-FR", {
      timeZone: "Europe/Paris",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric"
    });
    const formattedDate = rawDate
      .split(" ")
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    const messageLines = [
      `Tempo EDF (${period.label})`,
      formattedDate,
      `Signal : ${upperColor}`,
      `HP (${hpStart}-${hpEnd}) : ${hpPrice} €/kWh`,
      `HC (${hcStart}-${hcEnd}) : ${hcPrice} €/kWh`,
      `Solde ${lowerColor}s : ${remainingText}`
    ];

    const smsText = messageLines.join("\n").slice(0, MAX_SMS_LENGTH);

    await context.gateway.postJson(
      `/github/repos/${gatewayOwner}/${SMS_GATEWAY_REPO}/actions/workflows/${SMS_GATEWAY_WORKFLOW}/dispatches`,
      {
        ref: SMS_GATEWAY_REF,
        inputs: {
          to: recipients.join(","),
          message: smsText,
          alert_key: `tempo-${period.key}-${period.dateKey}`
        }
      },
      githubHeaders
    );

    context.state.set("TEMPO_LAST_SENT", period.key, period.dateKey);
    console.log(`Dispatched ${period.key} SMS to ${recipients.join(", ")} (${period.dateKey}: ${upperColor}).`);
    await context.sleep(DISPATCH_DELAY_MS);
  }
};
