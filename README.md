# Ollama for Claude Code

Use local and cloud Ollama models in Claude Code, in the terminal and Claude Desktop.


## Install

Requires Claude Code v2.1.326 or higher, a working Claude account, and Ollama running locally or available at a remote address.

```sh
claude plugin install ollama --marketplace ollama/ollama-claude-mod
```

Restart Claude Code or run the following in Claude Code after installation: 

`/restart plugins`

## Get started

New installs start with **Subagents** enabled. Claude Code opens with your usual Claude model, and subagents use Ollama. The mod saves Kimi Pro (`kimi-k3.1-pro:cloud`) for the conversation and DeepSeek Flash (`deepseek-v4.1-flash:cloud`) for subagents.

1. Run `/ollama` or select the three dots beside the mode picker to open Ollama settings.
2. Use the mode selector above the prompt to choose **Full** for Ollama in the conversation and subagents, or **Subagents** to keep Claude in the conversation.
3. Choose the model for the selected mode. Select **Off** whenever you want Claude for both roles.

In Claude Desktop, the Ollama controls choose the model for each turn independently of Claude's built-in model picker. The Ollama bar shows the conversation model when Ollama is enabled. With **Off** selected, Claude's own status line shows the model and effort.

| Setting | Conversation | Subagents |
|---|---|---|
| **Full** | Main Ollama model | Subagent Ollama model |
| **Subagents** | Claude | Subagent Ollama model |
| **Off** | Claude | Claude |

New chats inherit your last saved setup. Selecting **Off** keeps both model choices and the previously selected mode. Existing disabled setups stay disabled. The model picker includes local models and available Ollama cloud models. Type to search.

Settings shows the model and its supported effort options. Open **Advanced** for context length, the Ollama address, and request usage. Select the X to close settings and return to the compact status and worker activity. The compact mode button stays available after the first message. Errors remain visible when settings are closed; a failed model switch includes **Retry**. Workers show **Starting…** until their first response confirms the model.

To show tokens per second in the status bar, check **Show response speed** under **Settings → Advanced**. It starts off and applies across chats.

### Commands

```text
/ollama                   Open settings
/ollama full MODEL        Set the main model and enable Full
/ollama subagent MODEL    Set the worker model and enable Subagents
/ollama off               Select Off and keep saved model choices
/ollama status            Show the current setup
```

Ask Claude to use subagents normally. The plugin applies your selection to native Agent calls.

## Uninstall

In the Claude Code terminal, enter `/ollama uninstall`, then restart Claude Code. This removes the plugin and its entries from `/model`. Your saved chat preferences and picker entries you added or edited are kept.

The command defaults to a user install. For a project or local install, run `/ollama uninstall project` or `/ollama uninstall local` in that project. Shared picker entries are removed when the last install is gone.

Claude’s built-in uninstall has no plugin cleanup hook. If you already removed the last install through Claude, run `node scripts/model-picker.mjs uninstall` from this repository to finish cleaning up the picker.
