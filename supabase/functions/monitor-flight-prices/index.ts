import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

const getAdminKey = () => {
  const modernKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modernKeys) {
    const parsed = JSON.parse(modernKeys);
    if (parsed.default) return parsed.default;
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
};

const actorName = () => Deno.env.get("APIFY_ACTOR") || "memo23~easyjet-scraper";
const isMaximedupre = (actor: string) => actor.includes("maximedupre");

const minutesFromTime = (value: string) => {
  const [hours, minutes] = value.slice(0, 5).split(":").map(Number);
  return hours * 60 + minutes;
};

const clockDifference = (left: string, right: string) => {
  const difference = Math.abs(minutesFromTime(left) - minutesFromTime(right));
  return Math.min(difference, 1440 - difference);
};

const todayIso = () => new Date().toISOString().slice(0, 10);

const toDDMMYYYY = (iso: string) => iso.split("-").reverse().join("-");

const easyJetBookingUrl = (flight: any) => {
  if (!flight.return_date) {
    const params = new URLSearchParams({
      isOneWay: "on",
      pid: "www.easyjet.com",
      origin: flight.origin,
      destination: flight.destination,
      departureDate: flight.outbound_date,
      adults: "1",
      children: "0",
      infants: "0",
    });
    return `https://www.easyjet.com/en/buy/flights?${params}`;
  }
  // easyJet search-pod format: origin|destination|outDate|retDate|adults|children|infants|false||
  const outDate = toDDMMYYYY(flight.outbound_date);
  const retDate = toDDMMYYYY(flight.return_date);
  const flightsearch = `${encodeURIComponent(flight.origin)}%7C${encodeURIComponent(flight.destination)}%7C${outDate}%7C${retDate}%7C1%7C0%7C0%7Cfalse%7C%7C`;
  return `https://www.easyjet.com/en/searchpod.mvc/showsecureborderless?LeftHandSide=true&flightsearch=${flightsearch}`;
};

const buildApifyInput = (flight: any) => {
  const actor = actorName();
  if (isMaximedupre(actor)) {
    return {
      tripType: flight.return_date ? "roundTrip" : "oneWay",
      departureAirport: flight.origin,
      arrivalAirport: flight.destination,
      departureDate: flight.outbound_date,
      returnDate: flight.return_date || undefined,
      adults: 1,
      children: 0,
      infants: 0,
      sortBy: "cheapest",
      maxResults: 10,
    };
  }
  if (flight.return_date) {
    return {
      tripType: "roundTrip",
      origin: flight.origin,
      destination: flight.destination,
      departDateFrom: flight.outbound_date,
      departDateTo: flight.outbound_date,
      returnDateFrom: flight.return_date,
      returnDateTo: flight.return_date,
      adults: 1,
      children: 0,
      infants: 0,
      sortBy: "cheapest",
      maxResults: 10,
    };
  }
  return {
    tripType: "oneWay",
    origin: flight.origin,
    destination: flight.destination,
    departDateFrom: flight.outbound_date,
    departDateTo: flight.outbound_date,
    adults: 1,
    children: 0,
    infants: 0,
    sortBy: "cheapest",
    maxResults: 10,
  };
};

async function startApifyRun(flight: any, token: string) {
  const actor = actorName();
  const url = `https://api.apify.com/v2/acts/${actor}/runs?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildApifyInput(flight)),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Apify start failed (${res.status}): ${text.slice(0, 200)}`);
  const payload = JSON.parse(text);
  const run = payload.data;
  if (!run?.id) throw new Error("Apify start did not return a run ID");
  return { runId: run.id as string, actor, datasetId: run.defaultDatasetId as string };
}

async function getRunStatus(runId: string, actor: string, token: string) {
  const url = `https://api.apify.com/v2/acts/${actor}/runs/${runId}?token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`Apify status failed (${res.status}): ${text.slice(0, 200)}`);
  return JSON.parse(text).data;
}

async function getRunLog(run: any, actor: string, token: string) {
  try {
    const logId = run?.defaultLogId || `${actor}/${run?.id}`;
    const url = `https://api.apify.com/v2/logs/${logId}?token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) return "";
    const text = await res.text();
    return text.split("\n").slice(-20).join("\n");
  } catch {
    return "";
  }
}

async function getDatasetItems(datasetId: string, token: string) {
  const url = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Apify dataset failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function mapMemo23Candidate(item: any, desiredTime: string, flexMinutes: number) {
  const price = Number(item.price);
  const departureTime = item.departureTime || "";
  return {
    price,
    airline: item.carrierName || item.airline || "easyJet",
    flightNumber: item.flightNumber,
    departureTime,
    timeDiff: departureTime ? clockDifference(departureTime, desiredTime) : 9999,
  };
}

function processMemo23Items(flight: any, items: any[]) {
  if (!Array.isArray(items) || !items.length) throw new Error(`No easyJet flights returned for ${flight.origin}–${flight.destination}`);
  const outboundCandidates = items
    .filter((item: any) =>
      item &&
      item.direction === "outbound" &&
      item.departureDate === flight.outbound_date &&
      item.fromCode === flight.origin &&
      item.toCode === flight.destination &&
      !item.soldOut &&
      item.available !== false &&
      Number(item.price) > 0
    )
    .map((item: any) => mapMemo23Candidate(item, flight.outbound_time, flight.time_flex_minutes))
    .filter((option: any) => Number.isFinite(option.price) && option.price > 0 && option.timeDiff <= flight.time_flex_minutes)
    .sort((a: any, b: any) => a.timeDiff - b.timeDiff || a.price - b.price);

  if (!outboundCandidates.length) throw new Error(`No easyJet ${flight.origin}–${flight.destination} flight around ${flight.outbound_time.slice(0, 5)} on ${flight.outbound_date}`);
  const outbound = outboundCandidates[0];
  let inbound = null;

  if (flight.return_date) {
    const inboundCandidates = items
      .filter((item: any) =>
        item &&
        item.direction === "inbound" &&
        item.departureDate === flight.return_date &&
        item.fromCode === flight.destination &&
        item.toCode === flight.origin &&
        !item.soldOut &&
        item.available !== false &&
        Number(item.price) > 0
      )
      .map((item: any) => mapMemo23Candidate(item, flight.return_time, flight.time_flex_minutes))
      .filter((option: any) => Number.isFinite(option.price) && option.price > 0 && option.timeDiff <= flight.time_flex_minutes)
      .sort((a: any, b: any) => a.timeDiff - b.timeDiff || a.price - b.price);

    if (!inboundCandidates.length) throw new Error(`No easyJet ${flight.destination}–${flight.origin} flight around ${flight.return_time.slice(0, 5)} on ${flight.return_date}`);
    inbound = inboundCandidates[0];
  }

  return {
    outbound,
    inbound,
    total: outbound.price + (inbound?.price || 0),
  };
}

function processMaximedupreItems(flight: any, items: any[]) {
  if (!Array.isArray(items) || !items.length) throw new Error(`No easyJet flights returned for ${flight.origin}–${flight.destination}`);
  const candidates = items
    .filter((item: any) =>
      item &&
      item.departureDate === flight.outbound_date &&
      item.departureAirport?.code === flight.origin &&
      item.arrivalAirport?.code === flight.destination &&
      item.price?.total != null
    )
    .map((item: any) => {
      const departureTime = item.localDepartureTime || "";
      return {
        price: Number(item.price.total),
        outboundPrice: Number(item.price.outbound ?? item.price.total),
        returnPrice: item.price.return ? Number(item.price.return) : null,
        airline: item.carrierName || "easyJet",
        flightNumber: item.flightNumber,
        departureTime,
        timeDiff: departureTime ? clockDifference(departureTime, flight.outbound_time) : 9999,
      };
    })
    .filter((option: any) => Number.isFinite(option.price) && option.price > 0 && option.timeDiff <= flight.time_flex_minutes)
    .sort((a: any, b: any) => a.timeDiff - b.timeDiff || a.price - b.price);

  if (!candidates.length) throw new Error(`No easyJet ${flight.origin}–${flight.destination} flight around ${flight.outbound_time.slice(0, 5)} on ${flight.outbound_date}`);
  const best = candidates[0];
  return {
    outbound: { price: best.outboundPrice, airline: best.airline, flightNumber: best.flightNumber, departureTime: best.departureTime },
    inbound: best.returnPrice ? { price: best.returnPrice, airline: best.airline, flightNumber: "", departureTime: "" } : null,
    total: best.price,
  };
}

function processApifyItems(flight: any, items: any[]) {
  const actor = flight.apify_actor_id || actorName();
  if (isMaximedupre(actor)) return processMaximedupreItems(flight, items);
  return processMemo23Items(flight, items);
}

async function analyseEvents(geminiKey: string, flight: any) {
  if (!geminiKey) return null;
  const route = `${flight.origin} to ${flight.destination}`;
  const returnText = flight.return_date ? ` and return ${flight.return_date}` : "";
  const prompt = `You are advising a UK easyJet traveller trying to minimise airfare. Research current, verifiable demand factors for ${route} on ${flight.outbound_date}${returnText}. Check Bristol and Glasgow school holidays, bank holidays, major football/rugby fixtures, concerts, festivals and conferences close enough to affect this easyJet route. Return ONLY JSON with this shape: {"summary":"one concise sentence","risk":"low|medium|high","events":[{"name":"event or holiday","date":"YYYY-MM-DD or date range","location":"Bristol or Glasgow","impact":"one short explanation","risk":"low|medium|high"}]}. Include only events supported by current search results; use an empty events array if none are found.`;
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.1 },
    }),
  });
  if (!response.ok) throw new Error(`Gemini event analysis failed (${response.status})`);
  const payload = await response.json();
  const candidate = payload.candidates?.[0];
  const text = candidate?.content?.parts?.map((part: any) => part.text || "").join("") || "";
  const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  const analysis = JSON.parse(cleaned);
  const sources = (candidate?.groundingMetadata?.groundingChunks || [])
    .map((chunk: any) => chunk.web)
    .filter((source: any) => source?.uri)
    .map((source: any) => ({ title: source.title || "Source", url: source.uri }))
    .slice(0, 8);
  return { analysis, sources };
}

function buildRecommendation(flight: any, total: number, history: any[], eventAnalysis: any) {
  const previous = history[0]?.total_price ? Number(history[0].total_price) : null;
  const historicalPrices = history.map((item: any) => Number(item.total_price)).filter(Number.isFinite);
  const priorLow = historicalPrices.length ? Math.min(...historicalPrices) : null;
  const change = previous ? ((total - previous) / previous) * 100 : 0;
  const trend = previous === null ? "new" : change <= -3 ? "falling" : change >= 3 ? "rising" : "steady";
  const daysToGo = Math.ceil((new Date(`${flight.outbound_date}T12:00:00Z`).getTime() - Date.now()) / 86400000);
  const eventRisk = eventAnalysis?.risk || "low";
  const targetReached = flight.target_price && total <= Number(flight.target_price);
  const atObservedLow = priorLow !== null && total <= priorLow;
  const reasons: string[] = [];
  let recommendation = "watch";

  if (targetReached) reasons.push(`Your £${Number(flight.target_price).toFixed(0)} target has been reached.`);
  if (trend === "falling") reasons.push(`The fare fell ${Math.abs(change).toFixed(1)}% since the previous check.`);
  if (trend === "rising") reasons.push(`The fare rose ${change.toFixed(1)}% since the previous check.`);
  if (atObservedLow) reasons.push("This is the lowest fare recorded so far.");
  if (eventRisk === "high") reasons.push("Major local demand around these dates may reduce cheap availability.");
  if (daysToGo <= 21) reasons.push(`Departure is only ${Math.max(daysToGo, 0)} days away.`);

  if (targetReached || (atObservedLow && (trend === "rising" || daysToGo <= 45)) || daysToGo <= 14 || (eventRisk === "high" && daysToGo <= 60)) {
    recommendation = "book_now";
  } else if (atObservedLow || trend === "rising" || daysToGo <= 42) {
    recommendation = "consider_booking";
  }
  if (!reasons.length) reasons.push(history.length < 2 ? "More daily observations are needed for a reliable trend." : "The current fare is stable with no urgent demand signal.");

  const summary = recommendation === "book_now"
    ? `Book now: £${total.toFixed(2)} looks compelling for this trip.`
    : recommendation === "consider_booking"
      ? `Consider booking at £${total.toFixed(2)} rather than waiting too long.`
      : `Keep watching: today’s total is £${total.toFixed(2)}.`;
  return { recommendation, summary, reasons, trend, change, priorLow, daysToGo };
}

async function sendEmail(apiKey: string, to: string, title: string, message: string) {
  if (!apiKey || !to) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Orange Contract <onboarding@resend.dev>", to: [to], subject: title, html: `<h2>${title}</h2><p>${message}</p><p>Open Orange Contract to see the full price history.</p>` }),
  });
}

async function updateFlightWithPrices(admin: any, flight: any, outbound: any, inbound: any | null, total: number, geminiKey: string) {
  const { data: history } = await admin.from("flight_price_snapshots").select("total_price, observed_at").eq("planned_flight_id", flight.id).order("observed_at", { ascending: false }).limit(30);

  let eventAnalysis = { summary: "Event analysis will run when Gemini is configured.", risk: "low", events: flight.event_insights || [] };
  let eventSources = flight.event_sources || [];
  const eventsStale = !flight.events_checked_at || Date.now() - new Date(flight.events_checked_at).getTime() > 7 * 86400000;
  if (eventsStale && geminiKey) {
    try {
      const eventResult = await analyseEvents(geminiKey, flight);
      if (eventResult) {
        eventAnalysis = eventResult.analysis;
        eventSources = eventResult.sources;
      }
    } catch (error) {
      console.error("Event analysis error", flight.id, error);
    }
  } else if (flight.event_insights?.length) {
    eventAnalysis = { summary: "Existing event analysis retained.", risk: flight.event_insights.some((event: any) => event.risk === "high") ? "high" : "low", events: flight.event_insights };
  }

  const decision = buildRecommendation(flight, total, history || [], eventAnalysis);
  const bookingUrl = easyJetBookingUrl(flight);
  const snapshot = {
    planned_flight_id: flight.id,
    outbound_price: outbound.price,
    return_price: inbound?.price || null,
    total_price: total,
    outbound_airline: outbound.airline,
    return_airline: inbound?.airline || null,
    outbound_flight_number: outbound.flightNumber,
    return_flight_number: inbound?.flightNumber || null,
    outbound_actual_time: outbound.departureTime,
    return_actual_time: inbound?.departureTime || null,
    booking_url: bookingUrl,
  };
  const { error: snapshotError } = await admin.from("flight_price_snapshots").upsert(snapshot, { onConflict: "planned_flight_id,observed_on" });
  if (snapshotError) throw snapshotError;

  const lowest = Math.min(total, decision.priorLow ?? total, flight.lowest_total_price ? Number(flight.lowest_total_price) : total);
  const update: any = {
    latest_outbound_price: outbound.price,
    latest_return_price: inbound?.price || null,
    latest_total_price: total,
    lowest_total_price: lowest,
    trend: decision.trend,
    recommendation: decision.recommendation,
    recommendation_summary: decision.summary,
    recommendation_reasons: decision.reasons,
    event_insights: eventAnalysis.events || [],
    event_sources: eventSources,
    last_checked_at: new Date().toISOString(),
    last_error: null,
    updated_at: new Date().toISOString(),
    apify_run_id: null,
    apify_actor_id: null,
    apify_started_at: null,
  };
  if (eventsStale && geminiKey) update.events_checked_at = new Date().toISOString();
  const { error: updateError } = await admin.from("planned_flights").update(update).eq("id", flight.id);
  if (updateError) throw updateError;

  let alertType = "";
  if (flight.target_price && total <= Number(flight.target_price)) alertType = "target_reached";
  else if (decision.recommendation === "book_now" && flight.recommendation !== "book_now") alertType = "book_now";
  else if (decision.change <= -5) alertType = "price_drop";
  else if (decision.change >= 8) alertType = "price_rise";
  if (alertType) {
    const today = todayIso();
    const { data: existing } = await admin.from("flight_price_alerts").select("id").eq("planned_flight_id", flight.id).eq("alert_type", alertType).gte("created_at", `${today}T00:00:00Z`).limit(1);
    if (!existing?.length) {
      const title = `${flight.origin} → ${flight.destination}: ${decision.recommendation === "book_now" ? "book now" : "price update"}`;
      const message = `${decision.summary} ${decision.reasons[0]}`;
      await admin.from("flight_price_alerts").insert({ planned_flight_id: flight.id, alert_type: alertType, title, message, total_price: total });
      await sendEmail(Deno.env.get("RESEND_API_KEY") || "", Deno.env.get("ALERT_EMAIL") || "", title, message);
    }
  }
  return { total, recommendation: decision.recommendation, bookingUrl };
}

async function handleStart(admin: any, body: any) {
  const token = Deno.env.get("APIFY_API_TOKEN");
  if (!token) return json({ error: "APIFY_API_TOKEN is not configured" }, 500);

  let query = admin.from("planned_flights").select("*").eq("status", "tracking").gte("outbound_date", todayIso()).is("apify_run_id", null);
  if (body.flightId) query = query.eq("id", body.flightId);
  const { data: flights, error: flightsError } = await query.order("outbound_date");
  if (flightsError) throw flightsError;

  const started: any[] = [];
  const skipped: any[] = [];
  for (const flight of flights || []) {
    if (flight.apify_run_id) {
      skipped.push({ id: flight.id, runId: flight.apify_run_id });
      continue;
    }
    try {
      const { runId, actor } = await startApifyRun(flight, token);
      const { error: upErr } = await admin.from("planned_flights").update({
        apify_run_id: runId,
        apify_actor_id: actor,
        apify_started_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      }).eq("id", flight.id);
      if (upErr) throw upErr;
      started.push({ id: flight.id, runId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await admin.from("planned_flights").update({ last_error: message, last_checked_at: new Date().toISOString(), recommendation: "unavailable", updated_at: new Date().toISOString() }).eq("id", flight.id);
      started.push({ id: flight.id, ok: false, error: message });
    }
  }
  return json({ started, skipped });
}

async function handlePoll(admin: any, body: any) {
  const token = Deno.env.get("APIFY_API_TOKEN");
  if (!token) return json({ error: "APIFY_API_TOKEN is not configured" }, 500);

  let query = admin.from("planned_flights").select("*").not("apify_run_id", "is", null);
  if (body.flightId) query = query.eq("id", body.flightId);
  const { data: flights, error: flightsError } = await query;
  if (flightsError) throw flightsError;

  const geminiKey = Deno.env.get("GEMINI_API_KEY") || "";
  const processed: any[] = [];
  const stillPending: any[] = [];

  for (const flight of flights || []) {
    try {
      const actor = flight.apify_actor_id || actorName();
      const run = await getRunStatus(flight.apify_run_id, actor, token);
      if (run.status === "RUNNING" || run.status === "READY") {
        stillPending.push({ id: flight.id, status: run.status });
        continue;
      }
      if (run.status !== "SUCCEEDED") {
        const statusMessage = run?.statusMessage || "";
        const logTail = await getRunLog(run, actor, token);
        console.error(`Apify run ${flight.apify_run_id} FAILED for ${flight.origin}-${flight.destination}: ${statusMessage}`, logTail);
        throw new Error(`Apify run ${flight.apify_run_id} failed (${statusMessage || "no status message"}). ${logTail.slice(-200)}`);
      }
      const items = await getDatasetItems(run.defaultDatasetId, token);
      const { outbound, inbound, total } = processApifyItems(flight, items);
      const result = await updateFlightWithPrices(admin, flight, outbound, inbound, total, geminiKey);
      processed.push({ id: flight.id, ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await admin.from("planned_flights").update({
        apify_run_id: null,
        apify_actor_id: null,
        apify_started_at: null,
        last_error: message,
        last_checked_at: new Date().toISOString(),
        recommendation: "unavailable",
        updated_at: new Date().toISOString(),
      }).eq("id", flight.id);
      processed.push({ id: flight.id, ok: false, error: message });
    }
  }
  return json({ processed, stillPending });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const adminKey = getAdminKey();
    const admin = createClient(supabaseUrl, adminKey, { auth: { persistSession: false } });

    const { data: vaultSecret, error: vaultErr } = await admin.rpc("get_fare_watch_cron_secret") as unknown as { data: string | null; error: any };
    if (vaultErr) console.error("get_fare_watch_cron_secret error", vaultErr);
    const envSecret = Deno.env.get("CRON_SECRET") || "";
    const cronSecret = (vaultSecret || envSecret);
    const authorization = req.headers.get("Authorization") || "";
    const isCron = Boolean(cronSecret) && authorization === `Bearer ${cronSecret}`;

    if (!isCron) {
      const token = authorization.replace(/^Bearer\s+/i, "");
      if (!token) return json({ error: "Authentication required" }, 401);
      const { data, error } = await admin.auth.getUser(token);
      if (error || data.user?.email?.toLowerCase() !== "jenpayneg@gmail.com") return json({ error: "Not authorised" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action || "start";

    if (action === "start") return await handleStart(admin, body);
    if (action === "poll") return await handlePoll(admin, body);
    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});