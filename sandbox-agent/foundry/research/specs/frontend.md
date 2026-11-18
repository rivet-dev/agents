# frontend

we need to build a browser-friendly version of our tui. we should try to keep the tui and gui as close together as possible. add this to agents.md

be thorough and careful with your impelmentaiton. this is going to be the ground 0 for a lot of work so it needs to be clean and well structured with support for routing, clean state architecture, etc.

## tech

- vite
- baseui
- tanstack

## arch

- make sure that rivetkit is not imported in to either the cli or the gui. this should all be isoaletd in our client package. add this to agents.md

## agent session api

- expose the sandbox agent api on sandbox instance actor for managing sessions and sendin messages
- agent session api should use @sandbox-agent/persist-rivet for persisting to rivet

## layout

- left sidebar is similar to the hf switch ui:
    - list each repo
    - under each repo, show all of the tasks
    - you should see all tasks for the entire organization here grouped by repo
- the main content area shows the current organization
    - there is a main agent session for the main agent thatn's making the change, so show this by default
    - build a ui for interacting with sessions
    - see ~/sandbox-agent/frontend/packages/inspector/ for reference ui
- right sidebar
    - show all information about the current task

## testing

- use agent-browser cli to veirfy that all of this functionality works
    - create task
    - can see the task in the sidear
    - clik on task to see the agent transcript
