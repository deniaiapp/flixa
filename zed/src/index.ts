#!/usr/bin/env node
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { FlixaAgent } from './agent.js';

const input = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const output = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(input, output);
const agent = new FlixaAgent();

acp
  .agent({ name: 'flixa' })
  .onRequest('initialize', (context) => agent.initialize(context.params))
  .onRequest('session/new', (context) => agent.newSession(context.params))
  .onRequest('session/load', (context) => agent.loadSession(context.params, context.client))
  .onRequest('session/list', (context) => agent.listSessions(context.params))
  .onRequest('session/resume', (context) => agent.resumeSession(context.params))
  .onRequest('authenticate', (context) => agent.authenticate(context.params))
  .onRequest('logout', (context) => agent.logout(context.params))
  .onRequest('session/set_mode', (context) => agent.setSessionMode(context.params))
  .onRequest('session/set_config_option', (context) => agent.setSessionConfigOption(context.params))
  .onRequest('session/prompt', (context) => agent.prompt(context.params, context.client))
  .onNotification('session/cancel', (context) => agent.cancel(context.params))
  .connect(stream);
