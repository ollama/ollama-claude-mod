# Ollama for Claude Code

Use local and cloud Ollama models in Claude Code, in the terminal and Claude Desktop.

## Install

Requires Claude Code v2.1.326 or higher, a working Claude account, and Ollama running locally or available at a remote address.

```sh
claude plugin install ollama --marketplace ollama/ollama-claude-mod
```

To install the version in a local checkout, run `claude plugin install ollama --marketplace ./` from the repository root. After either install, start a new Claude Code session or enter `/reload-plugins` in an open session.

## Run from the terminal

```sh
# Use your saved routing mode when the mod is enabled.
claude

# Skip the Ollama mod for this session.
claude --settings '{"enabledPlugins":{"ollama@ollama":false}}'
```

`ollama@ollama` identifies the `ollama` plugin in the `ollama` marketplace. Append `-p "your prompt"` to either command for a single response. In an interactive session with the mod loaded, `/ollama off` routes the conversation and its subagents to Claude and keeps the Ollama controls available.

If you start Claude Code with `ollama launch claude`, Ollama's launcher controls the model and connection. The mod stays inactive for that session.

## Get started

New installs start in **Subagents** mode. Claude runs the conversation and **Inkling 2 Small** (`inkling-2-small:cloud`) runs its subagents. Until you pick a model, switching to **Full** selects **Kimi K3.1 Pro** (`kimi-k3.1-pro:cloud`) for both.

Soon you’ll be able to choose one Ollama model for the conversation and another for its subagents.

1. Run `/ollama` or select the three dots beside the mode picker to open Ollama settings.
2. Use the mode selector above the prompt to choose **Full** for Ollama in the conversation and subagents, or **Subagents** to keep Claude in the conversation.
3. To use the same Ollama model in either mode, choose it in settings or run `/ollama model MODEL`. An explicit choice stays selected when you switch modes, even if you picked the suggested model. Select **Off** whenever you want Claude for both roles.

The mod applies your Ollama model and effort when it sends a request to Ollama. Claude Code keeps the model selected for the chat or subagent and uses that selection for its own usage reports and context window. You can change the session model with Claude's built-in `/model` picker. The Ollama bar shows the conversation model when Ollama is enabled. In **Subagents**, it can read Claude's initial effort from the current Desktop chat's saved selection before the first request. With **Off** selected, Claude's own status line shows the model and effort.

| Mode | Conversation | Subagents |
|---|---|---|
| **Full** | Selected Ollama model | Selected Ollama model |
| **Subagents** | Claude | Selected Ollama model |
| **Off** | Claude | Claude |

New chats inherit your last saved model, mode, and effort. Resuming an existing chat restores its own setup. The model picker includes local models and available Ollama cloud models. Type to search.

The settings panel shows the Ollama model and its supported effort options. The mode selector stays in the status bar while settings are open. Select the X to close the panel. Select the subagent count to expand or collapse worker activity. Workers show **Starting…** until their first response confirms the model. Errors remain visible when settings are closed.

Open **Advanced** for context length, the Ollama address, and request usage. The context length picker offers **64K**, **128K**, **256K**, **512K**, and **1M** up to the reported limit. It also includes the running allocation and any configured default within that limit. Choosing the running allocation or the value marked **(Default)** clears the mod's saved limit. If the running allocation is larger than the configured default, choosing the smaller value sets an explicit limit. **Auto** appears when Ollama hasn't reported a size.

To show tokens per second in the status bar, set **Response speed** to **On** under **Settings → Advanced**. It starts off and applies across chats.

### Commands

Enter these in an interactive Claude Code session with the mod loaded.

```text
/ollama                   Open settings
/ollama model             Open the Ollama model picker
/ollama model MODEL       Use MODEL in both Ollama routing modes
/ollama full              Use Ollama for the conversation and its subagents
/ollama subagent          Use Ollama for subagents only
/ollama off               Select Off and keep the saved Ollama model
/ollama status            Show the current routing setup
```

Ask Claude to use subagents normally. The plugin applies your selection to native Agent calls.

## Uninstall

Run Claude Code's plugin manager from your shell to uninstall the mod and keep your saved chat preferences.

```sh
claude plugin uninstall ollama@ollama --keep-data
```

The default scope is `user`. For a project or local install, run the command from that project with `--scope project` or `--scope local`. Omit `--keep-data` to delete the mod's saved data when you remove its last installation. Start a new Claude Code session or run `/reload-plugins` to apply the change.

If Ollama entries still appear in Claude's `/model` picker after you remove the last installation, run `node scripts/model-picker.mjs uninstall` from this repository with Node.js 22.18 or later. It removes the entries the mod added and preserves entries you added or edited.
