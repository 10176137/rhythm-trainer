#!/usr/bin/env node
'use strict';

// Development MIDI probe. It never starts a scoring session and never writes
// practice history. Use it to prove OS enumeration, port open, and note events
// before debugging the application pipeline.

import { NodeMidiAdapter } from './adapter.mjs';
import { createJulusianBackend } from './julusian-backend.mjs';
import { noteName } from './codec.mjs';

function usage() {
  console.log(`Usage:
  npm run midi:probe                 # list input ports
  npm run midi:probe -- --device 0   # open by id/index
  npm run midi:probe -- --device "MEDELI SP-A500"  # open by name
  npm run midi:probe -- --json --device 0          # JSON event lines

Probe is read-only: it does not start a practice session or touch history.`);
}

function parseArgs(argv) {
  const args = { list: false, device: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') args.list = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--device') args.device = argv[++i] ?? null;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (args.device === null && !arg.startsWith('-')) args.device = arg;
    else {
      console.error(`Unknown argument: ${arg}`);
      args.help = true;
    }
  }
  return args;
}

function channelLabel(channel) {
  return Number.isInteger(channel) ? channel + 1 : '?';
}

function printEvent(event, json) {
  if (json) {
    console.log(JSON.stringify({ type: 'midi-event', ...event }));
    return;
  }
  const stamp = `${event.capturedAtMonotonicMs.toFixed(1)}ms`;
  const base = `seq=${event.sourceSeq} t=${stamp} gen=${event.connectionGeneration} src=${event.sourceId}`;
  if (event.messageType === 'note-on' || event.messageType === 'note-off') {
    console.log(
      `${event.messageType === 'note-on' ? 'Note On ' : 'Note Off'} ` +
      `ch=${channelLabel(event.channel)} note=${noteName(event.noteNumber)}(${event.noteNumber}) ` +
      `vel=${event.velocity} ${base} raw=[${event.rawData.join(' ')}]`,
    );
  } else if (event.messageType === 'control-change') {
    console.log(`CC${event.controllerNumber}=${event.controllerValue} ch=${channelLabel(event.channel)} ${base}`);
  } else {
    console.log(`Other ${base} raw=[${event.rawData.join(' ')}]`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }

  let backend;
  try {
    backend = createJulusianBackend();
  } catch (error) {
    console.error(`ERROR [${error.code ?? 'MIDI_BACKEND_UNAVAILABLE'}] ${error.message}`);
    process.exitCode = 2;
    return;
  }

  console.log(`probe: platform=${process.platform} arch=${process.arch} node=${process.version}`);
  console.log(`probe: backend=${backend.name} version=${backend.version} clockDomain=node-performance-monotonic`);

  const adapter = new NodeMidiAdapter({ backend: backend, queueCapacity: 512, traceCapacity: 200 });
  adapter.onDiagnostic((diagnostic) => {
    console.error(`DIAG [${diagnostic.code}] ${diagnostic.message}`);
  });
  adapter.onStatus((status) => {
    if (args.json) console.log(JSON.stringify({ type: 'midi-status', ...status }));
    else console.log(`status: connected=${status.connected} health=${status.inputHealth} device=${status.device?.name ?? '—'} generation=${status.generation}`);
  });

  let devices;
  try {
    devices = adapter.listInputs();
  } catch (error) {
    console.error(`ERROR [${error.code ?? 'MIDI_DEVICE_LIST_FAILED'}] ${error.message}`);
    process.exitCode = 2;
    return;
  }

  console.log(`input ports: ${devices.length}`);
  devices.forEach((device, index) => {
    console.log(`  [${index}] id=${device.id} name=${device.name}`);
  });
  if (devices.length === 0) {
    console.log('no MIDI input devices found (check USB TO HOST cable, power, and OS MIDI enumeration)');
    return;
  }
  if (!args.device) {
    console.log('list only. Add --device <id|name> to open an input and print key events.');
    return;
  }

  adapter.onEvent((event) => printEvent(event, args.json));
  try {
    adapter.openInput(args.device);
  } catch (error) {
    console.error(`ERROR [${error.code ?? 'MIDI_INPUT_OPEN_FAILED'}] ${error.message}`);
    process.exitCode = 2;
    return;
  }

  console.log('listening for MIDI input; press/release piano keys. Ctrl+C to stop.');
  await new Promise((resolve) => {
    const stop = () => {
      adapter.close('probe_exit');
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
