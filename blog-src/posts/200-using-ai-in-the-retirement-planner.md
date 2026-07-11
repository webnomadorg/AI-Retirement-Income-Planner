# Using AI in the Retirement Planner: Providers, Models, and API Keys

**SEO title:** Using AI in the Retirement Planner: Providers, Models, and API Keys Explained

**Category:** AI & Retirement

**Published:** 2026-07-10

**Image source base:** 200 ai models

**Image 1 alt:** AI Retirement Assistant settings panel showing the provider dropdown set to Anthropic (Claude), the API key field with Update and Remove key buttons, the model selector, and a Refresh button.

**Image 2 alt:** The model selector dropdown open in the AI Retirement Assistant, listing Claude models from claude-opus-4-8 (Most capable) through Sonnet, Haiku, and Fable 5.

**Image 3 alt:** The AI setup screen showing three ways to keep your API key on the device: encrypt with a password, do not save it, or save without a password, with a Save Key and Start Chatting button.

**Meta description:** How to use the AI features in the AI Retirement Income Planner: choosing a provider (Claude, OpenAI, Gemini, OpenRouter, Ollama, or custom), selecting a model, adding an API key safely, and the two AI modes.

**Suggested URL slug:** using-ai-in-the-retirement-planner

**Primary keyword:** AI retirement planner API key

**Educational disclaimer:** This article is for general education only. It is not financial, tax, investment, or legal advice, and it is not official guidance from any AI provider. AI models can be wrong. Always review AI suggestions against your own numbers and a qualified professional before acting. Provider names, models, and pricing change, so confirm current details with each provider.

## Quick Answer

The AI Retirement Income Planner includes an optional AI assistant that can read your plan, answer questions, and even propose specific numeric changes you approve with one click. It is a "bring your own key" feature: you pick an AI provider, paste in your own API key, and the planner talks to that provider directly from your browser.

You are not locked into one provider. The planner supports:

- Anthropic (Claude)
- OpenAI
- Google Gemini
- OpenRouter
- Ollama (local models on your own computer)
- Custom (any OpenAI-compatible endpoint)

For serious plan analysis and the change proposals, Claude Opus 4.8 or Claude Fable 5 are the recommended models, because the planner's AI prompts and proposal format were developed and tuned against Claude during development. For the lighter "Learn the planner" how-to chat, smaller or local models, including free local models in Ollama, work well and cost nothing to run.

The rest of this guide explains the two AI modes, each provider's strengths and weaknesses, how to select a model, how to add and protect your API key, and how to get a Claude key step by step.

[IMAGE 200 ai models 1]

## The Two AI Modes: Plan With AI and Learn the Planner

The AI Chat tab has two different modes, and it helps to know which one you are in.

**Plan with AI** works on your real plan. You ask for changes in plain English, and it returns specific numeric edits to your withdrawals, tax strategy, Roth conversions, and phase structure. Every proposed change set is checked against the simulation, and you review and approve it (or undo it) with one click. This is the mode that benefits most from a capable model.

**Learn the planner** is a grounded "how do I use this?" chat. It answers questions about the planner itself, such as where to set a claiming age or what an ACA cliff warning means, using the app's own help content. It can even hand a drafted question over to Plan mode for you. Because it is mostly explaining the tool rather than doing heavy analysis, it runs fine on cheaper or local models.

A simple rule of thumb: use a strong model (Claude Opus 4.8 or Fable 5) when you want the AI to analyse and change your plan, and a cheaper or local model when you just want help using the planner.

[IMAGE PLACEHOLDER - Generated diagram contrasting the two AI modes side by side. Left panel "Plan with AI": reads your plan, proposes numeric edits you approve, needs a capable model. Right panel "Learn the planner": explains how to use the app, runs on cheap or local models. Prompt for an AI image generator: "Create a clean editorial two-panel diagram comparing two modes of an AI assistant. Left panel labelled Plan with AI with icons for a chart and an approve check. Right panel labelled Learn the planner with a book and question-mark icon. Professional muted blue, green, and gold accents, white background, no logos, no tiny text."]

## Bring Your Own Key: How Your Data Is Handled

The planner does not run its own AI server. Instead, your API key is stored only in your browser, and your requests, including the plan figures the AI needs, are sent directly from your browser to the provider you chose. Nothing passes through a middle server run by the planner.

That has two consequences worth understanding:

- You pay the provider directly for what you use, at that provider's rates. There is no markup and no subscription to the planner for AI.
- Your plan figures (balances, ages, and tax inputs) are shared with the provider you selected, under your own account and their privacy terms. If that matters to you, read on to the Ollama option, which keeps everything on your own machine.

## The AI Providers, and Their Strengths and Weaknesses

Here is how the six options compare.

| Provider | Get a key from | Best for | Watch-outs |
| --- | --- | --- | --- |
| Anthropic (Claude) | console.anthropic.com | Plan analysis and change proposals; the recommended default | Paid usage; needs billing credits |
| OpenAI | platform.openai.com | General-purpose chat and analysis | Paid usage; quality varies by model |
| Google Gemini | aistudio.google.com/apikey | Low-cost analysis; has a free tier | Free tier has limits; quality varies |
| OpenRouter | openrouter.ai/keys | One key, many models from different makers | You are trusting a router in the middle |
| Ollama (local) | No key needed | Private, free, offline "Learn the planner" chat | Limited by your own hardware; needs a little setup |
| Custom (OpenAI-compatible) | Your own endpoint | Advanced users with their own gateway or model host | A custom host may be blocked by the app's security policy |

A few notes on the ends of that range:

**Anthropic (Claude)** is the recommended choice for plan work. Within Claude, the model dropdown labels tell you the trade-off: Opus models are marked "Most capable," Sonnet models are "Balanced (faster)," and Haiku is "Fastest and cheapest." Claude Fable 5 also appears in the list. For proposing changes to your plan, pick Opus 4.8 or Fable 5.

**Ollama** is different from the rest. It runs open models on your own computer, so there is no API key and no cost, and your plan data never leaves your device. It is the most private option and a great fit for the "Learn the planner" chat. The trade-offs are that answer quality depends on your hardware, and it needs a small amount of setup (install Ollama, and start it so the browser can reach it, for example with the setting `OLLAMA_ORIGINS=*`).

**OpenRouter and Custom** are flexibility options. OpenRouter gives you one key that can reach many different models. Custom lets advanced users point the planner at any OpenAI-compatible endpoint they run, although a custom host may be blocked by the app's built-in security policy unless it is one of the built-in providers.

## Which Model Should I Use?

The planner is happy to use any of these, but the results are not equal.

- **For Plan with AI (analysis and change proposals):** Claude Opus 4.8 or Claude Fable 5. These give the most reliable, best-formatted change proposals because the planner was tuned against Claude during development. This matters most when the AI is doing real work like [analysing your withdrawal strategy](/blog/which-retirement-account-withdraw-from-first.html) across phases or hardening the plan against a bad market.
- **For a good balance of speed and cost:** a "Balanced" Claude Sonnet model, or a mid-tier model from another provider.
- **For Learn the planner, or to keep everything free and private:** a small local model in Ollama, or a low-cost model such as Gemini Flash.

You do not have to commit to one. Each provider keeps its own saved key and model, so you can switch between, say, a local Ollama model for how-to questions and Claude Opus for a deep plan review, without re-entering anything.

## Selecting a Provider and Model in the Planner

Open the AI Chat tab and, if the settings are collapsed, open the settings panel. You will see three controls.

1. **Provider** is a dropdown listing all six options. Choose one, and the key field, help text, and model list update to match it.
2. **API key** is where you paste the key for that provider (Ollama needs none). Two buttons sit next to it: **Update** saves or changes the key, and **Remove key** deletes it from this device.
3. **Model** is a dropdown of suggested models, each with a short hint such as "Most capable" or "Fastest and cheapest." Next to it is a **Refresh** button.

[IMAGE 200 ai models 2]

About that model list: it is discovered live from the provider and cached for about an hour, so it stays current without an app update. If you just gained access to a new model, or you do not see one you expect, click **Refresh**. You can also simply type any model id straight into the box, which is handy for a specific Ollama model you have pulled or a brand-new release.

[IMAGE PLACEHOLDER - Annotated screenshot of the provider dropdown expanded to show all six providers (Anthropic, OpenAI, Gemini, OpenRouter, Ollama, Custom). Prompt for an AI image generator: "Create a clean UI illustration of a settings dropdown labelled Provider, expanded to show six list items: Anthropic (Claude), OpenAI, Google Gemini, OpenRouter, Ollama (local), Custom. Soft neutral background, professional muted blue and green accents, no logos, no tiny text."]

## Setting Up Your API Key Safely

When you first add a key, the planner asks how you want to keep it on your device. This is an important privacy choice, and there are three options.

[IMAGE 200 ai models 3]

- **Encrypt with a password** (recommended for your own device). The key is saved scrambled, and you enter your password once per browser session to unlock AI. Choose a password of at least six characters.
- **Do not save it, this session only** (recommended on a shared or public computer). The key is kept only until you close the browser, then you re-enter it next time.
- **Save without a password** (simplest, for a private device you trust). The key is readable by anyone who uses that computer.

One reassuring detail: if you forget the password, nothing is lost. You simply re-enter your API key. The password protects the stored key on your device, but it cannot protect against a compromised browser, so treat a shared computer with care and prefer the "do not save" option there.

Once a key is saved, the setup screen collapses into the compact settings panel, where the **Update** and **Remove key** buttons let you rotate or delete the key at any time.

If you would rather watch than read, the settings area has an **"API key setup"** link, marked with a small play icon, that opens a short video walkthrough of getting and pasting a key.

## Step by Step: Getting a Claude (Anthropic) API Key

Claude is the recommended provider, so here is the full path from nothing to a working key. The other providers follow a similar shape, just at a different website (see the table above).

1. **Create an account.** Go to console.anthropic.com and sign up, either with Google or Microsoft single sign-on or with an email and password.
2. **Verify your email** using the link Anthropic sends, then complete the short organization details form (name, entity type, country, and intended use).
3. **Add billing credits.** The Claude API is pay as you go, so you fund your account by entering payment details and adding a small amount of usage credit. You only pay for what you use.
4. **Create the key.** In the Console, open the API Keys section and create a new key. Copy it immediately; it starts with `sk-ant-` and is shown only once.
5. **Paste it into the planner.** Back in the AI Chat tab, set the provider to Anthropic (Claude), paste the key, choose how to store it, and click **Save Key and Start Chatting**.

A good habit: start with a small credit balance and a cheaper model while you get comfortable, then switch the model dropdown to Opus 4.8 or Fable 5 when you want a serious plan review.

## Getting Started With the AI Features

Once your key is in, you do not have to think up a question from scratch. Both modes offer starter chips you can click.

In **Plan with AI**, the starters include:

- Summarise and flag risks
- Tax bracket check
- ACA / CSR check
- Withdrawal strategy
- Propose optimisations
- Roth conversion advice

"Propose optimisations" is the one many people use first: it returns specific numeric changes sized to respect your tax brackets, ACA cliff, and IRMAA thresholds, which you can apply with one click. It pairs naturally with questions about [how much you can safely spend in retirement](/blog/how-much-can-i-spend-in-retirement.html).

In **Learn the planner**, the starters are how-to questions such as "Where do I set my Social Security claiming age?" or "How do I add a one-off lump sum like an inheritance?"

You can also send the AI a question straight from elsewhere in the app. Many results, including the stress tests and [Monte Carlo and historical backtests](/blog/monte-carlo-vs-historical-backtesting-retirement-planning.html), have an "Ask AI about this" button that opens the chat with a detailed, plan-aware question already written for you.

### Clearing the Conversation

The AI Chat tab has a **Clear** button in its header. It empties the current conversation so you can start fresh, and it asks you to confirm first because it cannot be undone. Clearing works per mode: it clears whichever conversation, Plan or Learn, you are currently viewing, and in Plan mode it also dismisses any pending change proposals.

## Privacy and Cost, in One Place

To summarise the trade-offs:

- **Most private and free:** Ollama, running a local model on your own machine. Nothing leaves your device.
- **Best plan analysis:** Anthropic Claude (Opus 4.8 or Fable 5), paid per use, with your plan figures sent to Anthropic under your own account.
- **Lowest paid cost:** a free-tier or low-cost model such as Gemini Flash, or a cheaper Claude Haiku model, especially for Learn-the-planner questions.

Whichever you choose, the key stays in your browser, the planner keeps running fully without AI if you prefer, and you can remove the key at any time.

## FAQ

### Do I need an API key to use the retirement planner?

No. The planner is fully usable without any AI. The AI assistant is an optional extra that needs a key from a provider you choose (except Ollama, which needs no key).

### Which AI model is best for retirement plan analysis?

Claude Opus 4.8 or Claude Fable 5. The planner's AI prompts and change-proposal format were tuned against Claude during development, so those models produce the most reliable plan edits.

### Can I use a free or local AI model?

Yes. Ollama runs open models on your own computer for free and keeps your data local, which is ideal for the "Learn the planner" chat. Google Gemini also has a free tier. Local and free models are less capable for deep plan analysis than Claude Opus or Fable 5.

### Is my retirement data safe when I use AI?

Your key and requests go directly from your browser to the provider you picked, never through a planner server. With Ollama, nothing leaves your device at all. With cloud providers, your plan figures are sent to that provider under your own account and their privacy terms.

### How do I switch to a newer model that is not listed?

Click the Refresh button next to the model dropdown to re-pull the provider's live model list (it is cached for about an hour), or type the exact model id directly into the box.

### How do I remove my API key?

Open the AI settings panel and click Remove key. You can also choose the "do not save it" option when entering a key so it is never stored between sessions.

### What is the difference between Plan with AI and Learn the planner?

Plan with AI reads your real plan and proposes numeric changes you approve. Learn the planner is a how-to chat about using the app. Plan mode benefits from a capable model; Learn mode runs fine on cheap or local models.

## Sources

- Anthropic, "How can I access the Claude API?": https://support.anthropic.com/en/articles/8114521-how-can-i-access-the-anthropic-api
- Anthropic, "I have created an account in Console, what should I do?": https://support.anthropic.com/en/articles/8114531-i-have-created-an-account-in-console-and-i-want-to-start-using-the-api-what-should-i-do
- Anthropic Console: https://console.anthropic.com
- OpenAI Platform API keys: https://platform.openai.com/api-keys
- Google AI Studio API keys: https://aistudio.google.com/apikey
- OpenRouter keys: https://openrouter.ai/keys
- Ollama: https://ollama.com

## CTA Blocks

Mid-article CTA:

The AI Retirement Income Planner lets you bring your own AI key and get plan-aware analysis and one-click changes, privately in your browser, with no AI subscription.

End-of-article CTA:

Want to try the AI features without committing? Start with a small Claude credit balance, or a free local Ollama model for how-to questions, then let Propose optimisations suggest specific, reviewable changes to your plan.

## Internal Link Suggestions

- Link to `006-which-retirement-account-should-i-withdraw-from-first.md` when discussing the Withdrawal strategy starter.
- Link to `019-how-much-can-i-spend-in-retirement.md` when discussing Propose optimisations and spending.
- Link to `087-monte-carlo-vs-historical-backtesting-for-retirement-planning.md` when discussing Ask AI about this on stress tests.
- Link to `093`, `094`, `095` (AI cluster) once published.

## Schema Notes

Use Article schema:

- headline: Using AI in the Retirement Planner: Providers, Models, and API Keys Explained
- description: How to use the AI features in the AI Retirement Income Planner, including choosing a provider, selecting a model, and adding an API key safely.
- articleSection: AI and Retirement Planning
- about: AI retirement planner, API key, Claude, OpenAI, Gemini, OpenRouter, Ollama, model selection

Use FAQPage schema for the FAQ section if the questions and answers are visible on the published page.

## Facebook Post Snippets

**Snippet 1:**
The AI Retirement Income Planner lets you bring your own AI key. Pick a provider (Claude, OpenAI, Gemini, OpenRouter, Ollama, or custom), paste a key, and the planner talks to it directly from your browser. No AI subscription, no middle server.

**Snippet 2:**
Which AI model for retirement plan analysis? Claude Opus 4.8 or Fable 5 are recommended, because the planner was tuned against Claude in development. For simple how-to questions, a free local Ollama model works great.

**Snippet 3:**
Your AI key stays in your browser, and with Ollama your plan never leaves your computer at all. New guide: choosing a provider, picking a model, and adding an API key safely, step by step.

## Newsletter Summary

The AI Retirement Income Planner has an optional, bring-your-own-key AI assistant. This guide explains the two modes (Plan with AI versus Learn the planner), compares the six providers (Claude, OpenAI, Gemini, OpenRouter, Ollama, and custom), recommends Claude Opus 4.8 or Fable 5 for plan analysis and local models for how-to chat, and walks through selecting a model, refreshing the model list, and adding an API key safely, including step-by-step Claude signup.
