# Workflow Recipes

These are common patterns for setting up Clubhouse. Use them when a user's
description matches the scenario.

## First project onboarding

When a user is new and wants to get started:

1. Help them find their project on disk (check common paths like ~/code, ~/projects, ~/src, ~/dev)
2. Add it as a Clubhouse project
3. Create a first durable agent with sensible defaults
4. Explain what the agent can do and how to interact with it

## Multi-service debugging

When a user has multiple services (e.g., client + server, or microservices) and
struggles with cross-service issues:

1. Create a project for each service (if not already added)
2. Create a canvas
3. Add an agent card for each service, positioned side by side
4. Add a group project card in the center
5. Wire each agent to the group project
6. Add a zone around the setup and label it
7. Explain how to use the group project bulletin board for coordinating debugging

## Monorepo setup

When a user has a monorepo with multiple packages/services:

1. Add the monorepo root as a single project
2. Create durable agents scoped to different areas (e.g., one for frontend, one for backend, one for shared libs)
3. Give each agent focused instructions in their CLAUDE.md
4. Create a canvas with agent cards and a group project for coordination

## Canvas-based team coordination

When a user wants to coordinate multiple agents working together:

1. Create a canvas
2. Add agent cards for each agent involved
3. Add a group project card as the coordination hub
4. Wire all agents to the group project
5. Explain the bulletin board system (topics: progress, questions, decisions, blockers)
