# Clean View

A Claude Code mod that makes Claude Code feel calm and friendly for people who aren't technical.

While Claude works, tool calls, file changes and command output are hidden. In their place, one simple checklist sits above the prompt, showing the plan, what's happening now and how far along it is:

```
Build my landing page · 1m 12s                     [ ● Clean View: ON ]
✓ Read your brand notes            ██████████  Done
▶ Build the pricing section        ██████░░░░  60%
○ Add the contact form             ░░░░░░░░░░  Next
○ Polish the footer                ░░░░░░░░░░  Up next
```

When Claude needs your OK, the header says **Needs you**. If something goes wrong, it says **Stuck** and explains why in one plain sentence. When the job finishes, it says **✓ All done**.

## Install

Type this at the prompt of a Claude Code terminal session:

```
/plugin install clean-view --marketplace kwilkins9/clean-view
```

Then:

1. Press `y` to add the marketplace.
2. Press Enter to install it for your user (all your sessions).

Clean View is on as soon as it installs.

## Turn it on or off

- Click the **● Clean View: ON** button at the right of the bar above your prompt.
- Or type `/simple off`, `/simple on`, or just `/simple` to flip it.

Your choice is remembered after a restart. When Clean View is off, everything Claude does is shown again.

## Good to know

- Claude plans its steps before it starts any work, so each request makes a few extra small tool calls.
- Each new request also asks Claude's smallest model (Haiku) for a short name for the job.
- Permission prompts still appear as usual. You always decide what Claude may do.

## For developers

Run the tests:

```
claude plugin test .
```

Check the plugin:

```
claude plugin validate .
```

Other mods can read the checklist from plugin state under the key `clean-view`. Its shape is described in `types/index.d.ts`.
