# Catchup

**The group chat that remembers what you decided.**

Built for the QMUL AI Hackathon, theme: Invisible AI.

## The problem
Group chats are where plans get made, and also where they get lost. A week later nobody remembers
whether it was Friday or Saturday, who was booking, or who was getting the cake.

## What it does
Catchup sits quietly inside a group chat. Nobody types a command or asks it anything. As people chat
normally, it picks out:

- **Plans** (what, when, where) and builds a shared board
- **Tasks**, and who volunteered for them (or flags them as "Unassigned")
- **Open decisions**, such as "Friday or Saturday?", and marks them decided once the group settles it
- It then **acts**: one click exports the plans as a calendar file (.ics) for Apple, Google or Outlook calendars

The chat is the only interface. The AI works in the background and the board updates by itself.

## How it fits Invisible AI
There is no chatbot and no prompt box for the AI. It reads what people are already doing (chatting)
and takes useful action automatically.

## How it works
1. A message arrives, either from a real Telegram group (the bot listens) or from the web page.
2. The server sends it to an LLM (Groq or Gemini) along with a computed two-week calendar and the
   current board, and asks for a fixed JSON format: events, tasks, decisions opened, decisions resolved.
3. The server merges the result into one shared board (deduplicating plans, tasks and decisions) and the
   page shows it live.

## Technical choices
- **Groq (OpenAI-compatible API)** as the main provider, with **Gemini** supported as an alternative.
  The server tries a list of models and falls back automatically. Temperature is low for consistency.
- **Node.js with no dependencies**: only built-in modules, nothing to install.
- **Telegram Bot API (long polling)** to read a real group chat. Needs no public URL.
- **The server computes the calendar** (which date is "Saturday") and passes it in, because small models
  are unreliable at weekday arithmetic.
- **Board state is passed back to the model each time**, so it can tell when a later message answers an
  earlier question and can reuse existing task names instead of duplicating them.
- **Plain HTML/CSS/JS front end**, no build step.

## Run it
```
cp .env.example .env      # then add your keys to .env
node server.js
```
Open http://localhost:3000 and press **Play demo chat**, or type your own messages.

### Telegram (optional)
1. In Telegram, message @BotFather, send `/newbot`, and copy the token into `.env` as `TELEGRAM_BOT_TOKEN`.
2. Send `/setprivacy` to @BotFather, pick your bot, choose **Disable** (so it can read group messages).
3. Create a group, add the bot, restart `node server.js`. Messages in the group appear on the board.

## Honest notes and limitations
- **Why Telegram?** It is the platform whose bot API lets a bot read a group freely. Most UK friend
  groups actually live on WhatsApp, iMessage and Instagram, which do not offer that. Telegram is the
  proof of concept; a production version would need a WhatsApp Business integration or an in-app feature.
- **Saved demo output**: if no AI key works, the scripted demo falls back to hand-written outputs. The page
  labels this clearly ("Saved demo output (no live AI)"). Those are not real AI results.
- The scripted demo pretends today is Mon 12 Oct 2026 so "Saturday" always resolves to 17 Oct.
- A small free-tier model sometimes resolves a decision too early or misses a task. Quality improves with a
  larger model (set `GROQ_MODEL`).
- Board state is held in memory and is lost on restart. There is no login or multi-chat separation.

## Privacy
- The demo uses a scripted chat, so no real people's messages are involved.
- In a real deployment the bot would only join a chat when invited, announce itself, store only the
  extracted items (not the raw messages), and use a provider with no-training guarantees.
- API keys are read from `.env`, which is excluded from git.
