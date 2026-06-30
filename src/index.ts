import "dotenv/config";
import { readFile } from "node:fs/promises";
import { schedule as cronSchedule, validate as cronValidate } from "node-cron";
import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import OpenAI from "openai";
import { PERSONA } from "./persona.js";
// Spectrum bridges a single agent loop to many messaging interfaces.
// Each provider in `providers` adds an interface (terminal TUI, iMessage, …).
// Docs: https://photon.codes/docs/spectrum-ts

// --- LLM (OpenRouter is OpenAI-compatible) ---------------------------------
const llm = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultHeaders: {
    "HTTP-Referer": "https://photon.codes",
    "X-Title": "imessage-knowledge-assistant",
  },
});
const MODEL = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
const DOC_PATH = process.env.DOC_PATH ?? "./knowledge.md";

// --- Topics + interest profile ---------------------------------------------
// `knowledge.md` holds the learner's stated topics. We parse them into a seed
// list and ask the LLM for an "interest profile" so that once the seeds are
// exhausted we can suggest fresh topics in the same spirit.
let seedTopics: string[] = [];
let interestProfile = "";

type Msg = { role: "user" | "assistant"; content: string };
type ConvState = {
  topics: string[];        // currently pickable topics
  phase: "topics" | "chat"; // topics = awaiting a topic pick; chat = in conversation
  currentTopic: string;
  history: Msg[];          // conversation memory for the current topic
  covered: Set<string>;    // every topic shown or conversed (avoids repeats in fresh batches)
};

function parseTopics(md: string): string[] {
  const lines = md.split(/\r?\n/);
  const numbered = lines
    .map((l) => /^\s*\d+[\.\)]\s*(.+?)\s*$/.exec(l)?.[1]?.trim())
    .filter((s): s is string => !!s && s.length > 0);
  if (numbered.length) return numbered;

  const headings = lines
    .map((l) => /^#{1,6}\s+(.+?)\s*#*$/.exec(l)?.[1]?.trim())
    .filter((s): s is string => !!s && s.length > 0);
  if (headings.length) return headings;

  return lines.map((l) => l.trim()).filter((l) => l.length > 0);
}

function parseList(reply: string): string[] {
  const items = reply
    .split(/\r?\n/)
    .map((l) => /^\s*\d+[\.\)]\s*(.+?)\s*$/.exec(l)?.[1]?.trim())
    .filter((s): s is string => !!s && s.length > 0);
  if (items.length) return items;
  return reply
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-\*•]\s*/, "").trim())
    .filter((l) => l.length > 0 && !/^#{1,6}\s/.test(l));
}

async function chat(system: string, messages: Msg[]): Promise<string> {
  try {
    const res = await llm.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        ...messages,
      ],
    });
    return res.choices[0]?.message?.content?.trim() || "";
  } catch (err) {
    console.error("LLM error:", err);
    return "";
  }
}

const PROFILE_SYS =
  "Summarise this learner's interests and the spirit of what they want to explore, in 2-3 sentences. Be concise.";
const NEWTOPICS_SYS =
  "You are a knowledgeable tutor. Based on the learner's interests, suggest fresh topics in the same spirit that they haven't covered yet. " +
  "Output ONLY a numbered list, one per line, exactly 'N. Topic'. No prose, no extra text.";

// Per-topic conversation system prompt.
const tutorSystem = (topic: string) =>
  `${PERSONA}\n\nYou are tutoring the learner on the topic: "${topic}". ` +
  `Stay rooted in it, but let the conversation wander wherever their curiosity leads. ` +
  `Prefer one focused idea per message over a wall of information — leave room for the learner to ask the next question rather than front-loading everything. ` +
  `When a topic is rich, do not lay out its full scope unprompted; answer the immediate question, then in a single line offer to go deeper or to another facet. Stop there. ` +
  `If the learner's message was already addressed earlier in this conversation, say so briefly and move the thread forward rather than repeating the explanation.`;

// Opening prompt: welcome the chosen topic and ask what they'd like to learn.
const openSystem = (topic: string) =>
  `${PERSONA}\n\nThe learner has just chosen to explore "${topic}". ` +
  `Welcome the choice in a sentence, then ask what they would most like to learn about it — or what drew them to it. ` +
  `One or two flowing sentences. No lists, no preamble, no greeting clichés.`;

async function loadKnowledge(): Promise<void> {
  const md = await readFile(DOC_PATH, "utf-8");
  seedTopics = parseTopics(md);
  interestProfile = (await chat(PROFILE_SYS, [{ role: "user", content: md }])) ||
    seedTopics.join(", ");
  console.log(`Loaded ${seedTopics.length} topics from ${DOC_PATH}`);
  console.log(`Interest profile: ${interestProfile}`);
}

try {
  await loadKnowledge();
} catch (err) {
  console.error(`Could not load document at ${DOC_PATH}:`, err);
  console.error("Set DOC_PATH in .env to a Markdown file and try again.");
  process.exit(1);
}

const convos = new Map<string, ConvState>();

function newState(): ConvState {
  return {
    topics: [...seedTopics],
    phase: "topics",
    currentTopic: "",
    history: [],
    covered: new Set(seedTopics),
  };
}

function topicList(s: ConvState): string {
  const lines = s.topics.map((t, i) => `${i + 1}. ${t}`);
  return `Here are the subjects awaiting us:\n\n${lines.join("\n")}\n\nReply with a number to begin, send "next" for fresh ones, or "reset" to return to your originals.`;
}

// Keep the conversation memory bounded.
function trim(history: Msg[]): void {
  const MAX = 24;
  if (history.length > MAX) history.splice(0, history.length - MAX);
}

// Begin a conversation on a topic: ask the learner what they'd like to learn.
async function openTopic(space: { send: (m: string) => Promise<unknown> }, s: ConvState, topic: string): Promise<void> {
  s.currentTopic = topic;
  s.phase = "chat";
  s.covered.add(topic);
  s.history = [{ role: "user", content: `I'd like to explore ${topic}.` }];
  const opening = await chat(openSystem(topic), s.history);
  s.history.push({ role: "assistant", content: opening });
  await space.send(opening || `What would you most like to learn about ${topic}?`);
}

// Generate fresh topics inspired by the learner's profile, excluding anything
// already shown or conversed. Adds the new topics to `covered` so later batches
// don't repeat them.
async function genNewTopics(s: ConvState): Promise<void> {
  const covered = [...s.covered].join(", ") || "(none)";
  const reply = await chat(
    NEWTOPICS_SYS,
    [{ role: "user", content: `Learner interests: ${interestProfile}\nAlready covered: ${covered}\nSuggest 5 fresh topics in the same spirit, none already covered.` }],
  );
  const topics = parseList(reply);
  if (topics.length) {
    s.topics = topics;
    topics.forEach((t) => s.covered.add(t));
  }
}

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [
    // iMessage
    imessage.config(),
  ],
});

// --- Daily morning discourse prompt ----------------------------------------
// If LEARNER_PHONE is set, the tutor proactively messages the learner each
// morning (default 08:00 Sydney time) with a prompt to pick a topic.
const LEARNER_PHONE = process.env.LEARNER_PHONE?.trim();
const MORNING_CRON = process.env.MORNING_CRON?.trim() || "0 8 * * *";
const MORNING_TZ = process.env.MORNING_TZ?.trim() || "Australia/Sydney";

type SpaceLike = { id: string; send: (c: string) => Promise<unknown> };

// Send the morning prompt and re-seed that conversation's state so a reply
// flows through the normal handler. Never throws — a cron failure must not
// crash the inbound loop.
async function sendMorning(space: SpaceLike): Promise<void> {
  try {
    const s = newState();
    convos.set(space.id, s);
    await space.send("Good Morning Prathksha☀️");
    await space.send(topicList(s));
  } catch (err) {
    console.error("Morning prompt error:", err);
  }
}

if (LEARNER_PHONE) {
  try {
    if (!cronValidate(MORNING_CRON)) {
      console.error(`Invalid MORNING_CRON "${MORNING_CRON}" — morning prompt disabled.`);
    } else {
      // `imessage(app)` narrows the app to its iMessage platform instance
      // (spaces-and-users.md). Its call signature's return type trips a
      // generic-inference check that tsc can't resolve here, so we cast to the
      // minimal shape we use — the runtime contract is unchanged.
      type ImNarrowed = {
        user: (id: string) => Promise<unknown>;
        space: (user: unknown) => Promise<SpaceLike>;
      };
      const im = (imessage as unknown as (a: typeof app) => ImNarrowed)(app);
      const learner = await im.user(LEARNER_PHONE);
      const dm = await im.space(learner);
      cronSchedule(MORNING_CRON, () => { void sendMorning(dm); }, { timezone: MORNING_TZ });
      console.log(`Morning prompt scheduled: "${MORNING_CRON}" ${MORNING_TZ} → ${LEARNER_PHONE}`);
    }
  } catch (err) {
    console.error("Could not set up morning prompt:", err);
  }
} else {
  console.log("Morning prompt disabled — set LEARNER_PHONE to enable.");
}

const greetings = new Set([
  "hi", "hey", "hello", "yo", "sup", "hiya", "hey there", "heya", "hai", "hii",
]);

// `app.messages` is an async iterable. Each tick yields a `space` (the
// conversation) and an inbound `message`. Reply by awaiting `space.send(...)`.
// NOTE: Spectrum's iMessage provider does not surface which message an inbound
// threaded reply targets (its `parentId` is for multi-attachment grouping, not
// conversational replies), so we can't anchor to a specific older message.
// We instead carry the full conversation history each turn, so replying to the
// most recent message continues seamlessly — and the learner can quote a
// snippet to branch back to an earlier point.
for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;
  const raw = message.content.text.trim();
  const lower = raw.toLowerCase();
  let s = convos.get(space.id) ?? newState();
  convos.set(space.id, s);

  // --- commands that apply in any phase ---
  if (lower === "reset") {
    s = newState();
    convos.set(space.id, s);
    await space.send("Back to your original subjects. " + topicList(s));
    continue;
  }

  if (lower === "reload") {
    try {
      await loadKnowledge();
      s = newState();
      convos.set(space.id, s);
      await space.send(`Reloaded ${seedTopics.length} topics. ` + topicList(s));
    } catch (err) {
      console.error("Reload error:", err);
      await space.send(`Couldn't reload ${DOC_PATH}. Check the file, then send "reload" again.`);
    }
    continue;
  }

  // Only the exact, standalone word "next" (or "fresh") triggers a new batch —
  // never the word appearing inside a sentence. Everything else is conversation.
  if (lower === "next" || lower === "fresh") {
    s.phase = "topics";
    s.currentTopic = "";
    s.history = [];
    await space.send("Let me think of some fresh subjects in the same spirit…");
    await genNewTopics(s);
    await space.send(topicList(s));
    continue;
  }

  if (lower === "back" || lower === "list" || lower === "topics" || lower === "start" || lower === "help") {
    s.phase = "topics";
    s.currentTopic = "";
    s.history = [];
    await space.send(topicList(s));
    continue;
  }

  // --- greetings: show the list only when between topics ---
  if ((greetings.has(lower) || /^h+i+$/.test(lower)) && s.phase === "topics") {
    await space.send(topicList(s));
    continue;
  }

  // --- topics phase: pick by number or type a fresh topic ---
  if (s.phase === "topics") {
    if (/^\d+$/.test(raw)) {
      const idx = Number(raw) - 1;
      const topic = s.topics[idx];
      if (!topic) {
        await space.send(`There's no topic at that number — pick between 1 and ${s.topics.length}, or send "next" for fresh ones.`);
        continue;
      }
      await openTopic(space, s, topic);
      continue;
    }
    // Free text becomes a brand-new topic.
    await openTopic(space, s, raw);
    continue;
  }

  // --- chat phase: a back-and-forth turn ---
  s.history.push({ role: "user", content: raw });
  trim(s.history);
  const reply = await chat(tutorSystem(s.currentTopic), s.history);
  if (!reply) {
    // Drop the unanswered user turn so history stays consistent.
    s.history.pop();
    await space.send("Forgive me — I lost my thread for a moment. Say that again?");
    continue;
  }
  s.history.push({ role: "assistant", content: reply });
  trim(s.history);
  await space.send(reply);
}