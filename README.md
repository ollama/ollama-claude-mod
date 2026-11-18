# Ollama for Claude Code

Use local and cloud Ollama models in Claude Code, in the terminal and Claude Desktop.


## Install

Requires Claude Code v2.1.326 or higher, a working Claude account, and Ollama running locally or available at a remote address.

```sh
claude plugin install ollama --marketplace ollama/ollama-claude-mod
```

Restart Claude Code or run the following in Claude Code after installation: 

`/restart plugins`

### Moving from ollama-local

For a user-scope install listed as `ollama@ollama-local`, close active Claude Code sessions and run these commands from a checkout of this version before following the install step above. The migration copies your saved chat preferences to `ollama@ollama`.

```sh
node scripts/migrate-settings.mjs && \
  claude plugin uninstall ollama@ollama-local --scope user --keep-data && \
  claude plugin marketplace remove ollama-local --scope user
```

## Get started

Run `/ollama` or open Settings above the prompt.

1. Choose a model.
2. Set **When to use Ollama** to **Always** or **Subagents Only**.
3. Select **Turn Ollama On**.

| Setting | Conversation | Subagents |
|---|---|---|
| **Always** | Ollama | Ollama |
| **Subagents Only** | Claude | Ollama |
| **Off** | Claude | Claude |

The model picker includes local models and available Ollama cloud models. Type to search.

Settings also includes the model’s supported effort options, an editable context length, and the Ollama connection address.

### Commands

```text
/ollama                   Open settings
/ollama full MODEL        Use Ollama for the conversation and subagents
/ollama subagent MODEL    Use Ollama for subagents
/ollama off               Return new work to Claude
/ollama status            Show the current setup
```

Ask Claude to use subagents normally. The plugin applies your selection to native Agent calls.

## Uninstall

In the Claude Code terminal, enter `/ollama uninstall`, then restart Claude Code. This removes the plugin and its entries from `/model`. Your saved chat preferences and picker entries you added or edited are kept.

The command defaults to a user install. For a project or local install, run `/ollama uninstall project` or `/ollama uninstall local` in that project. Shared picker entries are removed when the last install is gone.

Claude’s built-in uninstall has no plugin cleanup hook. If you already removed the last install through Claude, run `node scripts/model-picker.mjs uninstall` from this repository to finish cleaning up the picker.
