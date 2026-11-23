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

New installs start in **Subagents** mode. Claude runs the conversation and **Inkling 2 Small** (`inkling-2-small:cloud`) runs its subagents. Until you pick a model, switching to **Full** selects **Kimi K3.1 Pro** (`kimi-k3.1-pro:cloud`) for both.

1. Run `/ollama` or select the three dots beside the mode picker to open Ollama settings.
2. Use the mode selector above the prompt to choose **Full** for Ollama in the conversation and subagents, or **Subagents** to keep Claude in the conversation.
3. To use the same Ollama model in either mode, choose it in settings or run `/ollama model MODEL`. An explicit choice stays selected when you switch modes, even if you picked the suggested model. Select **Off** whenever you want Claude for both roles.

The mod applies your Ollama model and effort when it sends a request to Ollama. Claude Code keeps the model selected for the chat or subagent and uses that selection for its own usage reports and context window. You can change the session model with Claude's built-in `/model` picker. The Ollama bar shows the conversation model when Ollama is enabled. In **Subagents**, it can read Claude's initial effort from the current Desktop chat's saved selection before the first request. With **Off** selected, Claude's own status line shows the model and effort.

| Setting | Conversation | Subagents |
|---|---|---|
| **Full** | Selected Ollama model | Selected Ollama model |
| **Subagents** | Claude | Selected Ollama model |
| **Off** | Claude | Claude |

With `ollama launch claude`, the launcher controls the model and connection. The mod leaves that session’s prompts, requests, and interface to the launcher.

New chats inherit your last saved model, mode, and effort. Resuming an existing chat restores its own setup. The model picker includes local models and available Ollama cloud models. Type to search.

Settings shows the model and its supported effort options. Open **Advanced** for context length, the Ollama address, and request usage. Select the X to close settings and return to the compact status and worker activity. The compact mode button stays available after the first message. Errors remain visible when settings are closed. Workers show **Starting…** until their first response confirms the model.

The context length picker selects the running allocation or the configured default. **(Default)** marks a verified default from the model or the local Ollama app. Selecting the running allocation or the marked default clears the plugin's saved limit. If the model is running with a larger allocation, you can select its configured size as an explicit limit. **Auto** appears when Ollama hasn't reported a size.

To show tokens per second in the status bar, set **Response speed** to **On** under **Settings → Advanced**. It starts off and applies across chats.

### Commands

```text
/ollama                   Open settings
/ollama model [MODEL]     Open the model picker or set the shared Ollama model
/ollama full              Enable Full with the selected Ollama model
/ollama subagent          Enable Subagents with the selected Ollama model
/ollama off               Select Off and keep the saved Ollama model
/ollama status            Show the current setup
```

Ask Claude to use subagents normally. The plugin applies your selection to native Agent calls.

## Uninstall

In the Claude Code terminal, enter `/ollama uninstall`, then restart Claude Code. This removes the plugin and its entries from `/model`. Your saved chat preferences and picker entries you added or edited are kept.

The command defaults to a user install. For a project or local install, run `/ollama uninstall project` or `/ollama uninstall local` in that project. Shared picker entries are removed when the last install is gone.

Claude’s built-in uninstall has no plugin cleanup hook. If you already removed the last install through Claude, run `node scripts/model-picker.mjs uninstall` from this repository to finish cleaning up the picker.
