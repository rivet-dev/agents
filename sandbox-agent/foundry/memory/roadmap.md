## workflow

### terminal

1. hf create "do something"
2. notifies via openclaw

### claude code/opencode

1. "task this task to do xxxx"
2. ask clarifying questions
3. works in background (attach opencode session with `hf attach` and switch to session with `hf switch`)
4. automatically submits draft pr (if configured)
5. notifies via openclaw (wip)

### openclaw

(similar to claude code)

### mobile

1. open opencode web ui

## todo

- add -a flag to add to create to attach to it
- backend mode
- fix our tests
- update icons.rs to include colors for the icons

## ideas

- reminders (ctrl r)
- notifications
- check for duplicates/simlar prs
- if plan -> searches for exsiting funcionality, creates plan asking clarying questions
- automatically check off of todo list when done
- fix opencode path, cannot find config file
- unread indicato
    - add inbox that is the source of truth for this
    - show this on hf above everything else
- sync command
- refactor sessions: ~/.claude/plans/sleepy-frolicking-nest.md
- keep switch active after archive
- add an icon if there are merge conflicts
- add `hf -`
- ask -> do research in a codebase
- todo list integrations (linear, github, etc)
    - show issues due soon in switch
    - search issues from cli
    - create issues from cli
- keep tmux window name in sync with the agent status
- move all tools (github, graphite, git) too tools/ folder
- show git tree
- editor plugins
    - vs code
    - tmux
    - zed
    - opencode web
- have hf switch periodically refresh on agent status
- add new columns
    - model (for the agent)
- todo list & plan management -> with simplenote sync
- sqlite (global)
- list of all global task repos
- heartbeat status to tell openclaw what it needs to send you
- sandbox agent sdk support
- serve command to run server
- multi-repo support (list for all repos)
- pluggable notification system
- cron jobs
- sandbox support
    - auto-boot sandboxes for prs
- menubar
- notes integration

## cool details

- automatically uses your opencode theme
- auto symlink target/node_modules/etc
- auto-archives tasks when closed
- shows agent status in the tmux window name
