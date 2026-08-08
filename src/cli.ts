#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { FlightSearchAgent, type AgentOptions, type ProgressEvent } from './agent/flight-search-agent.js';
import { LlmPlanner } from './agent/llm-planner.js';
import { formatSearchReport, toJsonReport } from './agent/result-formatter.js';
import { AgentError } from './errors.js';
import { SessionMemory } from './memory/session-memory.js';
import { describeRequest, type FlightRequest } from './models/flight-request.js';
import { createDefaultRegistry, createMockRegistry } from './providers/index.js';
import { createLogger, setLogLevel, type LogLevel } from './utils/logger.js';

const log = createLogger('cli');

interface CliOptions {
  query?: string;
  json: boolean;
  mock: boolean;
  headed: boolean;
  diagnostics: boolean;
  skipVerification: boolean;
  only?: string[];
  exclude?: string[];
  maxDestinations?: number;
  maxDatePairs?: number;
  concurrency?: number;
  currency?: string;
  origin?: string;
  logLevel?: LogLevel;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    mock: false,
    headed: false,
    diagnostics: false,
    skipVerification: false,
    help: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string | undefined => argv[++i];

    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--mock':
        options.mock = true;
        break;
      case '--headed':
        options.headed = true;
        break;
      case '--diagnostics':
        options.diagnostics = true;
        break;
      case '--no-verify':
        options.skipVerification = true;
        break;
      case '--only':
        options.only = next()?.split(',').map((value) => value.trim()).filter(Boolean);
        break;
      case '--exclude':
        options.exclude = next()?.split(',').map((value) => value.trim()).filter(Boolean);
        break;
      case '--max-destinations':
        options.maxDestinations = Number(next());
        break;
      case '--max-date-pairs':
        options.maxDatePairs = Number(next());
        break;
      case '--concurrency':
        options.concurrency = Number(next());
        break;
      case '--currency':
        options.currency = next()?.toUpperCase();
        break;
      case '--origin':
        options.origin = next();
        break;
      case '--log-level':
        options.logLevel = next() as LogLevel;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Opsion i panjohur: ${arg}`);
        positional.push(arg);
    }
  }

  if (positional.length > 0) options.query = positional.join(' ');
  return options;
}

const HELP = `
✈️  Flight Search Agent

Përdorimi:
  flight-agent "Më gjej fluturimin më të lirë nga Prishtina për në Gjermani më 15 shtator"
  flight-agent                     # modaliteti interaktiv

Opsione:
  --mock                 Përdor të dhëna demo, pa rrjet (për testim të pipeline-it)
  --headed               Hap Chrome-in me dritare të dukshme
  --json                 Nxjerr rezultatin si JSON
  --diagnostics          Shto përmbledhjen e burimeve që u konsultuan
  --no-verify            Mos verifiko çmimin duke hapur ofertën
  --only a,b             Përdor vetëm këto burime (google_flights, skyscanner, kayak, momondo, wizzair)
  --exclude a,b          Përjashto këto burime
  --origin "Prishtina"   Origjina e paracaktuar kur nuk përmendet
  --currency EUR         Valuta e krahasimit
  --max-destinations N   Sa aeroporte të provohen kur jepet vetëm shteti (default 6)
  --max-date-pairs N     Sa kombinime datash për kërkim fleksibël (default 5)
  --concurrency N        Sa tabe browser-i njëkohësisht (default 3)
  --log-level L          silent | error | warn | info | debug
  -h, --help             Kjo ndihmë

Komanda në modalitetin interaktiv:
  /prefs                 Shfaq preferencat e ruajtura
  /clear                 Fshij preferencat
  /help                  Ndihmë
  /exit                  Dil
`;

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(HELP.trim());
    return;
  }
  if (options.logLevel) setLogLevel(options.logLevel);
  if (options.headed) process.env.FLIGHT_AGENT_HEADED = '1';

  const memory = new SessionMemory();
  if (options.origin) memory.remember({ origin: options.origin });
  if (options.currency) memory.remember({ currency: options.currency });

  const planner = new LlmPlanner({
    memory,
    defaultOrigin: options.origin,
    defaultCurrency: options.currency,
  });

  const agentOptions: AgentOptions = {
    registry: options.mock ? createMockRegistry() : createDefaultRegistry(),
    memory,
    onProgress: options.json ? undefined : renderProgress,
    skipVerification: options.skipVerification,
  };
  if (options.only) agentOptions.only = options.only;
  if (options.exclude) agentOptions.exclude = options.exclude;
  if (options.maxDestinations) agentOptions.maxDestinations = options.maxDestinations;
  if (options.maxDatePairs) agentOptions.maxDatePairs = options.maxDatePairs;
  if (options.concurrency) agentOptions.concurrency = options.concurrency;

  const agent = new FlightSearchAgent(agentOptions);

  // The browser must come down even on Ctrl-C, or Chrome is left running headless.
  let closing = false;
  const shutdown = async (code = 0): Promise<void> => {
    if (closing) return;
    closing = true;
    await agent.close().catch(() => undefined);
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(130));
  process.on('SIGTERM', () => void shutdown(143));

  try {
    if (options.query) {
      const ok = await runOnce(agent, planner, options.query, options);
      process.exitCode = ok ? 0 : 1;
    } else {
      await runInteractive(agent, planner, memory, options);
    }
  } finally {
    if (!closing) {
      closing = true;
      await agent.close().catch(() => undefined);
    }
  }
}

async function runOnce(
  agent: FlightSearchAgent,
  planner: LlmPlanner,
  query: string,
  options: CliOptions,
): Promise<boolean> {
  const plan = await planner.plan(query);

  if (plan.missing.length > 0) {
    // Ask for exactly the one missing thing (spec §15), rather than re-prompting for everything.
    console.log(`\n❓ ${plan.question}`);
    if (plan.notes.length > 0) console.log(plan.notes.map((note) => `   ${note}`).join('\n'));
    return false;
  }

  return runSearch(agent, plan.request, plan.notes, options);
}

async function runSearch(
  agent: FlightSearchAgent,
  request: FlightRequest,
  notes: string[],
  options: CliOptions,
): Promise<boolean> {
  if (!options.json) {
    console.log(`\n🔎 ${describeRequest(request)}`);
    for (const note of notes) console.log(`   ${note}`);
    console.log('');
  }

  try {
    const report = await agent.search(request);
    report.notes.unshift(...notes);

    if (options.json) {
      console.log(JSON.stringify(toJsonReport(report), null, 2));
    } else {
      clearProgressLine();
      console.log(`\n${formatSearchReport(report, { includeDiagnostics: options.diagnostics })}\n`);
    }
    return Boolean(report.comparison.cheapest);
  } catch (error) {
    clearProgressLine();
    const agentError = error instanceof AgentError ? error : undefined;
    const message = agentError ? agentError.userMessage : (error as Error).message;
    if (options.json) {
      console.log(JSON.stringify({ error: agentError?.toJSON() ?? { message } }, null, 2));
    } else {
      console.error(`\n❌ ${message}`);
      if (agentError?.kind === 'browser_unavailable') {
        console.error('   Instalo Chrome/Chromium, ose provo `--mock` për të parë pipeline-in pa rrjet.');
      }
    }
    log.debug('gabim i plotë', error);
    return false;
  }
}

async function runInteractive(
  agent: FlightSearchAgent,
  planner: LlmPlanner,
  memory: SessionMemory,
  options: CliOptions,
): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log('✈️  Flight Search Agent — shkruaj kërkesën, ose /help për ndihmë. /exit për të dalë.\n');

  try {
    for (;;) {
      const line = (await rl.question('> ')).trim();
      if (!line) continue;

      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        console.log(HELP.trim());
        continue;
      }
      if (line === '/prefs') {
        console.log(memory.describe());
        continue;
      }
      if (line === '/clear') {
        memory.clear();
        console.log('Preferencat u fshinë.');
        continue;
      }

      const plan = await planner.plan(line);
      if (plan.missing.length > 0) {
        // Follow-up answer for the single missing field, then retry with the combined text.
        console.log(`❓ ${plan.question}`);
        const answer = (await rl.question('  > ')).trim();
        if (!answer) continue;
        const retry = await planner.plan(`${line} ${answer}`);
        if (retry.missing.length > 0) {
          console.log(`❓ ${retry.question} (kërkesa nuk u plotësua, provo ta rishkruash)`);
          continue;
        }
        await runSearch(agent, retry.request, retry.notes, options);
        continue;
      }

      await runSearch(agent, plan.request, plan.notes, options);
    }
  } finally {
    rl.close();
  }
}

let progressActive = false;

function renderProgress(event: ProgressEvent): void {
  if (!stdout.isTTY) {
    if (event.phase !== 'searching') console.error(`… ${event.message}`);
    return;
  }
  const counter = event.total ? ` [${event.completed ?? 0}/${event.total}]` : '';
  const icon = { planning: '🧭', searching: '🌐', comparing: '⚖️', verifying: '🔍', done: '✅' }[event.phase];
  const line = `${icon} ${event.message}${counter}`;
  stdout.write(`\r${line.slice(0, (stdout.columns ?? 100) - 1).padEnd((stdout.columns ?? 100) - 1)}`);
  progressActive = true;
}

function clearProgressLine(): void {
  if (progressActive && stdout.isTTY) {
    stdout.write(`\r${' '.repeat((stdout.columns ?? 100) - 1)}\r`);
    progressActive = false;
  }
}

main().catch((error) => {
  console.error('Gabim fatal:', error);
  process.exit(1);
});
