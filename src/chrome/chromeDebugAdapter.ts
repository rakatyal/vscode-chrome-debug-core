/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {DebugProtocol} from 'vscode-debugprotocol';
import {InitializedEvent, TerminatedEvent, Handles, ContinuedEvent, BreakpointEvent, OutputEvent, Logger, logger} from 'vscode-debugadapter';

import {ICommonRequestArgs, ILaunchRequestArgs, ISetBreakpointsArgs, ISetBreakpointsResponseBody, IStackTraceResponseBody,
    IAttachRequestArgs, IScopesResponseBody, IVariablesResponseBody,
    ISourceResponseBody, IThreadsResponseBody, IEvaluateResponseBody, ISetVariableResponseBody, IDebugAdapter,
    ICompletionsResponseBody, IToggleSkipFileStatusArgs, IInternalStackTraceResponseBody, ILoadedScript, IAllLoadedScriptsResponseBody,
    IExceptionInfoResponseBody, ISetBreakpointResult, TimeTravelRuntime} from '../debugAdapterInterfaces';
import {IChromeDebugAdapterOpts, ChromeDebugSession} from './chromeDebugSession';
import {ChromeConnection} from './chromeConnection';
import * as ChromeUtils from './chromeUtils';
import Crdp from '../../crdp/crdp';
import {PropertyContainer, ScopeContainer, ExceptionContainer, isIndexedPropName} from './variables';
import * as variables from './variables';
import {formatConsoleArguments, formatExceptionDetails} from './consoleHelper';
import {StoppedEvent2, ReasonType} from './stoppedEvent';

import * as errors from '../errors';
import * as utils from '../utils';
import {telemetry} from '../telemetry';

import {LineColTransformer} from '../transformers/lineNumberTransformer';
import {BasePathTransformer} from '../transformers/basePathTransformer';
import {RemotePathTransformer} from '../transformers/remotePathTransformer';
import {BaseSourceMapTransformer} from '../transformers/baseSourceMapTransformer';
import {EagerSourceMapTransformer} from '../transformers/eagerSourceMapTransformer';

import * as path from 'path';

import * as nls from 'vscode-nls';
const localize = nls.config(process.env.VSCODE_NLS_CONFIG)();

interface IPropCount {
    indexedVariables: number;
    namedVariables: number;
}

/**
 * Represents a reference to a source/script. `contents` is set if there are inlined sources.
 * Otherwise, scriptId can be used to retrieve the contents from the runtime.
 */
export interface ISourceContainer {
    /** The runtime-side scriptId of this script */
    scriptId?: Crdp.Runtime.ScriptId;
    /** The contents of this script, if they are inlined in the sourcemap */
    contents?: string;
    /** The authored path to this script (only set if the contents are inlined) */
    mappedPath?: string;
}

interface IPendingBreakpoint {
    args: ISetBreakpointsArgs;
    ids: number[];
    requestSeq: number;
}

interface IHitConditionBreakpoint {
    numHits: number;
    shouldPause: (numHits: number) => boolean;
}

export type VariableContext = 'variables' | 'watch' | 'repl' | 'hover';

type CrdpScript = Crdp.Debugger.ScriptParsedEvent;

export abstract class ChromeDebugAdapter implements IDebugAdapter {
    public static EVAL_NAME_PREFIX = 'VM';
    private static SCRIPTS_COMMAND = '.scripts';
    private static THREAD_ID = 1;
    private static SET_BREAKPOINTS_TIMEOUT = 5000;
    private static HITCONDITION_MATCHER = /^(>|>=|=|<|<=|%)?\s*([0-9]+)$/;
    private static ASYNC_CALL_STACK_DEPTH = 4;

    protected _session: ChromeDebugSession;
    private _clientAttached: boolean;
    private _currentPauseNotification: Crdp.Debugger.PausedEvent;
    private _committedBreakpointsByUrl: Map<string, Crdp.Debugger.BreakpointId[]>;
    private _exception: Crdp.Runtime.RemoteObject;
    private _setBreakpointsRequestQ: Promise<any>;
    private _expectingResumedEvent: boolean;
    protected _expectingStopReason: ReasonType;
    private _waitAfterStep = Promise.resolve();

    private _frameHandles: Handles<Crdp.Debugger.CallFrame>;
    private _variableHandles: variables.VariableHandles;
    private _breakpointIdHandles: utils.ReverseHandles<Crdp.Debugger.BreakpointId>;
    private _sourceHandles: utils.ReverseHandles<ISourceContainer>;

    private _scriptsById: Map<Crdp.Runtime.ScriptId, CrdpScript>;
    private _scriptsByUrl: Map<string, CrdpScript>;
    private _pendingBreakpointsByUrl: Map<string, IPendingBreakpoint>;
    private _hitConditionBreakpointsById: Map<Crdp.Debugger.BreakpointId, IHitConditionBreakpoint>;

    private _chromeConnection: ChromeConnection;

    private _lineColTransformer: LineColTransformer;
    protected _sourceMapTransformer: BaseSourceMapTransformer;
    protected _pathTransformer: BasePathTransformer;

    protected _hasTerminated: boolean;
    protected _inShutdown: boolean;
    protected _attachMode: boolean;
    protected _launchAttachArgs: ICommonRequestArgs;
    private _blackboxedRegexes: RegExp[] = [];
    private _skipFileStatuses = new Map<string, boolean>();

    private _currentStep = Promise.resolve();
    private _nextUnboundBreakpointId = 0;

    private _columnBreakpointsEnabled: boolean;

    private _smartStepCount = 0;

    private _initialSourceMapsP = Promise.resolve();

    private _lastPauseState: { expecting: ReasonType; event: Crdp.Debugger.PausedEvent };

    public constructor({ chromeConnection, lineColTransformer, sourceMapTransformer, pathTransformer, targetFilter }: IChromeDebugAdapterOpts, session: ChromeDebugSession) {
        telemetry.setupEventHandler(e => session.sendEvent(e));
        this._session = session;
        this._chromeConnection = new (chromeConnection || ChromeConnection)(undefined, targetFilter);

        this._frameHandles = new Handles<Crdp.Debugger.CallFrame>();
        this._variableHandles = new variables.VariableHandles();
        this._breakpointIdHandles = new utils.ReverseHandles<Crdp.Debugger.BreakpointId>();
        this._sourceHandles = new utils.ReverseHandles<ISourceContainer>();
        this._pendingBreakpointsByUrl = new Map<string, IPendingBreakpoint>();
        this._hitConditionBreakpointsById = new Map<Crdp.Debugger.BreakpointId, IHitConditionBreakpoint>();

        this._lineColTransformer = new (lineColTransformer || LineColTransformer)(this._session);
        this._sourceMapTransformer = new (sourceMapTransformer || EagerSourceMapTransformer)(this._sourceHandles);
        this._pathTransformer = new (pathTransformer || RemotePathTransformer)();

        this.clearTargetContext();
    }

    protected get chrome(): Crdp.CrdpClient {
        return this._chromeConnection.api;
    }

    /**
     * Called on 'clearEverything' or on a navigation/refresh
     */
    protected clearTargetContext(): void {
        this._sourceMapTransformer.clearTargetContext();

        this._scriptsById = new Map<Crdp.Runtime.ScriptId, Crdp.Debugger.ScriptParsedEvent>();
        this._scriptsByUrl = new Map<string, Crdp.Debugger.ScriptParsedEvent>();

        this._committedBreakpointsByUrl = new Map<string, Crdp.Debugger.BreakpointId[]>();
        this._setBreakpointsRequestQ = Promise.resolve();

        this._pathTransformer.clearTargetContext();
    }

    public initialize(args: DebugProtocol.InitializeRequestArguments): DebugProtocol.Capabilities {
        if (args.pathFormat !== 'path') {
            return Promise.reject(errors.pathFormat());
        }

        // because session bypasses dispatchRequest
        if (typeof args.linesStartAt1 === 'boolean') {
            (<any>this)._clientLinesStartAt1 = args.linesStartAt1;
        }
        if (typeof args.columnsStartAt1 === 'boolean') {
            (<any>this)._clientColumnsStartAt1 = args.columnsStartAt1;
        }

        // This debug adapter supports two exception breakpoint filters
        return {
            exceptionBreakpointFilters: [
                {
                    label: localize('exceptions.all', "All Exceptions"),
                    filter: 'all',
                    default: false
                },
                {
                    label: localize('exceptions.uncaught', "Uncaught Exceptions"),
                    filter: 'uncaught',
                    default: true
                }
            ],
            supportsConfigurationDoneRequest: true,
            supportsSetVariable: true,
            supportsConditionalBreakpoints: true,
            supportsCompletionsRequest: true,
            supportsHitConditionalBreakpoints: true,
            supportsRestartFrame: true,
            supportsExceptionInfoRequest: true
        };
    }

    public configurationDone(): Promise<void> {
        return Promise.resolve();
    }

    public launch(args: ILaunchRequestArgs): Promise<void> {
        this.commonArgs(args);
        this._sourceMapTransformer.launch(args);
        this._pathTransformer.launch(args);

        telemetry.reportEvent('debugStarted', { request: 'launch', args: Object.keys(args) });
        return Promise.resolve();
    }

    public attach(args: IAttachRequestArgs): Promise<void> {
        this._attachMode = true;
        this.commonArgs(args);
        this._sourceMapTransformer.attach(args);
        this._pathTransformer.attach(args);

        if (!args.port) {
            args.port = 9229;
        }

        telemetry.reportEvent('debugStarted', { request: 'attach', args: Object.keys(args) });
        return this.doAttach(args.port, args.url, args.address, args.timeout, args.websocketUrl);
    }

    protected commonArgs(args: ICommonRequestArgs): void {
        if (args.trace === 'verbose') {
            logger.setup(Logger.LogLevel.Verbose, /*logToFile=*/true);
        } else if (args.trace) {
            logger.setup(Logger.LogLevel.Warn, /*logToFile=*/true);
        } else if (args.verboseDiagnosticLogging) { // deprecated
            logger.setup(Logger.LogLevel.Verbose, /*logToFile=*/true);
        } else if (args.diagnosticLogging) { // deprecated
            logger.setup(Logger.LogLevel.Log, /*logToFile=*/true);
        } else {
            logger.setup(Logger.LogLevel.Warn, /*logToFile=*/false);
        }

        this._launchAttachArgs = args;

        // Enable sourcemaps and async callstacks by default
        args.sourceMaps = typeof args.sourceMaps === 'undefined' || args.sourceMaps;
    }

    public shutdown(): void {
        this._inShutdown = true;
        this._session.shutdown();
    }

    protected terminateSession(reason: string, restart?: boolean): void {
        logger.log('Terminated: ' + reason);

        if (!this._hasTerminated) {
            telemetry.reportEvent('debugStopped', { reason });
            this._hasTerminated = true;
            if (this._clientAttached) {
                this._session.sendEvent(new TerminatedEvent(restart));
            }

            if (this._chromeConnection.isAttached) {
                this._chromeConnection.close();
            }
        }
    }

    /**
     * Hook up all connection events
     */
    protected hookConnectionEvents(): void {
        this.chrome.Debugger.onPaused(params => this.onPaused(params));
        this.chrome.Debugger.onResumed(() => this.onResumed());
        this.chrome.Debugger.onScriptParsed(params => this.onScriptParsed(params));
        this.chrome.Debugger.onBreakpointResolved(params => this.onBreakpointResolved(params));

        this.chrome.Console.onMessageAdded(params => this.onMessageAdded(params));
        this.chrome.Runtime.onConsoleAPICalled(params => this.onConsoleAPICalled(params));
        this.chrome.Runtime.onExceptionThrown(params => this.onExceptionThrown(params));
        this.chrome.Runtime.onExecutionContextsCleared(() => this.onExecutionContextsCleared());

        this._chromeConnection.onClose(() => this.terminateSession('websocket closed'));
    }

    /**
     * Enable clients and run connection
     */
    protected runConnection(): Promise<void>[] {
        return [
            this.chrome.Console.enable()
                .catch(e => { /* Specifically ignore a fail here since it's only for backcompat */ }),
            this.chrome.Debugger.enable(),
            this.chrome.Runtime.enable(),
            this._chromeConnection.run()
        ];
    }

    protected async doAttach(port: number, targetUrl?: string, address?: string, timeout?: number, websocketUrl?: string): Promise<void> {
        // Client is attaching - if not attached to the chrome target, create a connection and attach
        this._clientAttached = true;
        if (!this._chromeConnection.isAttached) {
            if (websocketUrl) {
                await this._chromeConnection.attachToWebsocketUrl(websocketUrl);
            } else {
                await this._chromeConnection.attach(address, port, targetUrl, timeout);
            }

            this.hookConnectionEvents();
            let patterns: string[] = [];

            if (this._launchAttachArgs.skipFiles) {
                const skipFilesArgs = this._launchAttachArgs.skipFiles.filter(glob => {
                    if (glob.startsWith('!')) {
                        logger.warn(`Warning: skipFiles entries starting with '!' aren't supported and will be ignored. ("${glob}")`);
                        return false;
                    }

                    return true;
                });

                patterns = skipFilesArgs.map(glob => utils.pathGlobToBlackboxedRegex(glob));
            }

            if (this._launchAttachArgs.skipFileRegExps) {
                patterns = patterns.concat(this._launchAttachArgs.skipFileRegExps);
            }

            if (patterns.length) {
                this._blackboxedRegexes = patterns.map(pattern => new RegExp(pattern, 'i'));
                this.refreshBlackboxPatterns();
            }

            await Promise.all(this.runConnection());

            const maxDepth = this._launchAttachArgs.showAsyncStacks ? ChromeDebugAdapter.ASYNC_CALL_STACK_DEPTH : 0;
            return this.chrome.Debugger.setAsyncCallStackDepth({ maxDepth });
        } else {
            return Promise.resolve();
        }
    }

    /**
     * This event tells the client to begin sending setBP requests, etc. Some consumers need to override this
     * to send it at a later time of their choosing.
     */
    protected sendInitializedEvent(): void {
        // Wait to finish loading sourcemaps from the initial scriptParsed events
        if (this._initialSourceMapsP) {
            this._initialSourceMapsP.then(() => {
                this._session.sendEvent(new InitializedEvent());
                this._initialSourceMapsP = null;
            });
        }
    }

    /**
     * e.g. the target navigated
     */
    private onExecutionContextsCleared(): void {
        this.clearTargetContext();
    }

    protected onPaused(notification: Crdp.Debugger.PausedEvent, expectingStopReason = this._expectingStopReason): void {
        this._variableHandles.onPaused();
        this._frameHandles.reset();
        this._exception = undefined;
        this._lastPauseState = { event: notification, expecting: expectingStopReason };
        this._currentPauseNotification = notification;

        // We can tell when we've broken on an exception. Otherwise if hitBreakpoints is set, assume we hit a
        // breakpoint. If not set, assume it was a step. We can't tell the difference between step and 'break on anything'.
        let reason: ReasonType;
        let smartStepP = Promise.resolve(false);
        if (notification.reason === 'exception') {
            reason = 'exception';
            this._exception = notification.data;
        } else if (notification.reason === 'promiseRejection') {
            reason = 'promise_rejection';
            this._exception = notification.data;
        } else if (notification.hitBreakpoints && notification.hitBreakpoints.length) {
            reason = 'breakpoint';

            // Did we hit a hit condition breakpoint?
            for (let hitBp of notification.hitBreakpoints) {
                if (this._hitConditionBreakpointsById.has(hitBp)) {
                    // Increment the hit count and check whether to pause
                    const hitConditionBp = this._hitConditionBreakpointsById.get(hitBp);
                    hitConditionBp.numHits++;
                    // Only resume if we didn't break for some user action (step, pause button)
                    if (!expectingStopReason && !hitConditionBp.shouldPause(hitConditionBp.numHits)) {
                        this.chrome.Debugger.resume();
                        return;
                    }
                }
            }
        } else if (expectingStopReason) {
            // If this was a step, check whether to smart step
            reason = expectingStopReason;
            smartStepP = this.shouldSmartStep(this._currentPauseNotification.callFrames[0]);
        } else {
            reason = 'debugger_statement';
        }

        this._expectingStopReason = undefined;

        smartStepP.then(should => {
            if (should) {
                this._smartStepCount++;
                return this.stepIn();
            } else {
                if (this._smartStepCount > 0) {
                    logger.log(`SmartStep: Skipped ${this._smartStepCount} steps`);
                    this._smartStepCount = 0;
                }

                // Enforce that the stopped event is not fired until we've send the response to the step that induced it.
                // Also with a timeout just to ensure things keep moving
                const sendStoppedEvent = () => {
                    const exceptionText = this._exception && this._exception.description && utils.firstLine(this._exception.description);
                    return this._session.sendEvent(new StoppedEvent2(reason, /*threadId=*/ChromeDebugAdapter.THREAD_ID, exceptionText));
                };
                return utils.promiseTimeout(this._currentStep, /*timeoutMs=*/300)
                    .then(sendStoppedEvent, sendStoppedEvent);
            }
        }).catch(err => logger.error('Problem while smart stepping: ' + (err && err.stack) ? err.stack : err));
    }

    public async exceptionInfo(args: DebugProtocol.ExceptionInfoArguments): Promise<IExceptionInfoResponseBody> {
        if (args.threadId !== ChromeDebugAdapter.THREAD_ID) {
            throw errors.invalidThread(args.threadId);
        }

        if (this._exception) {
            const response: IExceptionInfoResponseBody = {
                exceptionId: this._exception.className,
                breakMode: 'unhandled',
                details: {
                    stackTrace: this._exception.description && await this.mapFormattedException(this._exception.description)
                }
            };

            return response;
        } else {
            throw errors.noStoredException();
        }
    }

    private async shouldSmartStep(frame: Crdp.Debugger.CallFrame): Promise<boolean> {
        if (!this.smartStepEnabled()) return Promise.resolve(false);

        const stackFrame = this.callFrameToStackFrame(frame);
        const clientPath = this._pathTransformer.getClientPathFromTargetPath(stackFrame.source.path) || stackFrame.source.path;
        const mapping = await this._sourceMapTransformer.mapToAuthored(clientPath, frame.location.lineNumber, frame.location.columnNumber);

        return !mapping;
    }

    private smartStepEnabled(): boolean {
        return this._launchAttachArgs.sourceMaps && this._launchAttachArgs.smartStep;
    }

    protected onResumed(): void {
        this._currentPauseNotification = null;

        if (this._expectingResumedEvent) {
            this._expectingResumedEvent = false;

            // Need to wait to eval just a little after each step, because of #148
            this._waitAfterStep = utils.promiseTimeout(null, 50);
        } else {
            let resumedEvent = new ContinuedEvent(ChromeDebugAdapter.THREAD_ID);
            this._session.sendEvent(resumedEvent);
        }
    }

    private async detectColumnBreakpointSupport(scriptId: Crdp.Runtime.ScriptId): Promise<void> {
        this._columnBreakpointsEnabled = false; // So it isn't requested multiple times
        try {
            await this.chrome.Debugger.getPossibleBreakpoints({
                start: { scriptId, lineNumber: 0, columnNumber: 0 },
                end: { scriptId, lineNumber: 1, columnNumber: 0 },
                restrictToFunction: false
            });
            this._columnBreakpointsEnabled = true;
        } catch (e) {
            this._columnBreakpointsEnabled = false;
        }

        this._lineColTransformer.columnBreakpointsEnabled = this._columnBreakpointsEnabled;
    }

    protected async onScriptParsed(script: Crdp.Debugger.ScriptParsedEvent): Promise<void> {
        if (typeof this._columnBreakpointsEnabled === 'undefined') {
            this.detectColumnBreakpointSupport(script.scriptId).then(() => {
                this.sendInitializedEvent();
            });
        }

        if (script.url) {
            script.url = utils.fixDriveLetter(script.url);
        } else {
            script.url = ChromeDebugAdapter.EVAL_NAME_PREFIX + script.scriptId;
        }

        this._scriptsById.set(script.scriptId, script);
        this._scriptsByUrl.set(script.url, script);

        const resolvePendingBPs = source => {
            if (this._pendingBreakpointsByUrl.has(source)) {
                this.resolvePendingBreakpoint(this._pendingBreakpointsByUrl.get(source))
                    .then(() => this._pendingBreakpointsByUrl.delete(source));
            }
        };

        const mappedUrl = this._pathTransformer.scriptParsed(script.url);
        const sourceMapsP = this._sourceMapTransformer.scriptParsed(mappedUrl, script.sourceMapURL).then(sources => {
            if (sources) {
                sources
                    .filter(source => source !== mappedUrl) // Tools like babel-register will produce sources with the same path as the generated script
                    .forEach(resolvePendingBPs);
            }

            resolvePendingBPs(mappedUrl);
            return this.resolveSkipFiles(script, mappedUrl, sources);
        });

        if (this._initialSourceMapsP) {
            this._initialSourceMapsP = <Promise<any>>Promise.all([this._initialSourceMapsP, sourceMapsP]);
        }
    }

    private async resolveSkipFiles(script: CrdpScript, mappedUrl: string, sources: string[], toggling?: boolean): Promise<void> {
        if (sources && sources.length) {
            const parentIsSkipped = this.shouldSkipSource(script.url);
            const details = await this._sourceMapTransformer.allSourcePathDetails(mappedUrl);
            const libPositions: Crdp.Debugger.ScriptPosition[] = [];

            // Figure out skip/noskip transitions within script
            let inLibRange = parentIsSkipped;
            details.forEach(async (detail, i) => {
                let isSkippedFile = this.shouldSkipSource(detail.inferredPath);
                if (typeof isSkippedFile !== 'boolean') {
                    // Inherit the parent's status
                    isSkippedFile = parentIsSkipped;
                }

                this._skipFileStatuses.set(detail.inferredPath, isSkippedFile);

                if ((isSkippedFile && !inLibRange) || (!isSkippedFile && inLibRange)) {
                    libPositions.push({
                        lineNumber: detail.startPosition.line,
                        columnNumber: detail.startPosition.column
                    });
                    inLibRange = !inLibRange;
                }
            });

            // If there's any change from the default, set proper blackboxed ranges
            if (libPositions.length || toggling) {
                if (parentIsSkipped) {
                    libPositions.splice(0, 0, { lineNumber: 0, columnNumber: 0});
                }

                await this.chrome.Debugger.setBlackboxedRanges({
                    scriptId: script.scriptId,
                    positions: []
                }).catch(() => this.warnNoSkipFiles());

                if (libPositions.length) {
                    this.chrome.Debugger.setBlackboxedRanges({
                        scriptId: script.scriptId,
                        positions: libPositions
                    }).catch(() => this.warnNoSkipFiles());
                }
            }
        } else {
            const status = await this.getSkipStatus(mappedUrl);
            const skippedByPattern = this.matchesSkipFilesPatterns(mappedUrl);
            if (typeof status === 'boolean' && status !== skippedByPattern) {
                const positions = status ? [{ lineNumber: 0, columnNumber: 0 }] : [];
                this.chrome.Debugger.setBlackboxedRanges({
                    scriptId: script.scriptId,
                    positions
                }).catch(() => this.warnNoSkipFiles());
            }
        }
    }

    private warnNoSkipFiles(): void {
        logger.log('Warning: this runtime does not support skipFiles');
    }

    /**
     * If the source has a saved skip status, return that, whether true or false.
     * If not, check it against the patterns list.
     */
    private shouldSkipSource(sourcePath: string): boolean|undefined {
        const status = this.getSkipStatus(sourcePath);
        if (typeof status === 'boolean') {
            return status;
        }

        if (this.matchesSkipFilesPatterns(sourcePath)) {
            return true;
        }

        return undefined;
    }

    /**
     * Returns true if this path matches one of the static skip patterns
     */
    private matchesSkipFilesPatterns(sourcePath: string): boolean {
        return this._blackboxedRegexes.some(regex => {
            return regex.test(sourcePath);
        });
    }

    /**
     * Returns the current skip status for this path, which is either an authored or generated script.
     */
    private getSkipStatus(sourcePath: string): boolean|undefined {
        if (this._skipFileStatuses.has(sourcePath)) {
            return this._skipFileStatuses.get(sourcePath);
        }

        return undefined;
    }

    public async toggleSkipFileStatus(args: IToggleSkipFileStatusArgs): Promise<void> {
        if (args.path) {
            args.path = utils.fileUrlToPath(args.path);
        }

        if (!await this.isInCurrentStack(args)) {
            // Only valid for files that are in the current stack
            const logName = args.path || this.displayNameForSourceReference(args.sourceReference);
            logger.log(`Can't toggle the skipFile status for ${logName} - it's not in the current stack.`);
            return;
        }

        // e.g. strip <node_internals>/
        if (args.path) {
            args.path = this.displayPathToRealPath(args.path);
        }

        const aPath = args.path || this.fakeUrlForSourceReference(args.sourceReference);
        const generatedPath = await this._sourceMapTransformer.getGeneratedPathFromAuthoredPath(aPath);
        if (!generatedPath) {
            logger.log(`Can't toggle the skipFile status for: ${aPath} - haven't seen it yet.`);
            return;
        }

        const sources = await this._sourceMapTransformer.allSources(generatedPath);
        if (generatedPath === aPath && sources.length) {
            // Ignore toggling skip status for generated scripts with sources
            logger.log(`Can't toggle skipFile status for ${aPath} - it's a script with a sourcemap`);
            return;
        }

        const newStatus = !this.shouldSkipSource(aPath);
        logger.log(`Setting the skip file status for: ${aPath} to ${newStatus}`);
        this._skipFileStatuses.set(aPath, newStatus);

        const targetPath = this._pathTransformer.getTargetPathFromClientPath(generatedPath);
        const script = this.getScriptByUrl(targetPath);

        await this.resolveSkipFiles(script, generatedPath, sources, /*toggling=*/true);

        if (newStatus) {
            this.makeRegexesSkip(script.url);
        } else {
            this.makeRegexesNotSkip(script.url);
        }

        this.onPaused(this._lastPauseState.event, this._lastPauseState.expecting);
    }

    private async isInCurrentStack(args: IToggleSkipFileStatusArgs): Promise<boolean> {
        const currentStack = await this.stackTrace({ threadId: undefined });

        if (args.path) {
            return currentStack.stackFrames.some(frame => frame.source.path === args.path);
        } else {
            return currentStack.stackFrames.some(frame => frame.source.sourceReference === args.sourceReference);
        }
    }

    private makeRegexesNotSkip(noSkipPath: string): void {
        let somethingChanged = false;
        this._blackboxedRegexes = this._blackboxedRegexes.map(regex => {
            const result = utils.makeRegexNotMatchPath(regex, noSkipPath);
            somethingChanged = somethingChanged || (result !== regex);
            return result;
        });

        if (somethingChanged) {
            this.refreshBlackboxPatterns();
        }
    }

    private makeRegexesSkip(skipPath: string): void {
        let somethingChanged = false;
        this._blackboxedRegexes = this._blackboxedRegexes.map(regex => {
            const result = utils.makeRegexMatchPath(regex, skipPath);
            somethingChanged = somethingChanged || (result !== regex);
            return result;
        });

        if (!somethingChanged) {
            this._blackboxedRegexes.push(new RegExp(utils.pathToRegex(skipPath), 'i'));
        }

        this.refreshBlackboxPatterns();
    }

    private refreshBlackboxPatterns(): void {
        this.chrome.Debugger.setBlackboxPatterns({
            patterns: this._blackboxedRegexes.map(regex => regex.source)
        }).catch(() => this.warnNoSkipFiles());
    }

    public async getLoadedScripts(): Promise<IAllLoadedScriptsResponseBody> {
        const loadedScripts = Array.from(this._scriptsByUrl.keys())
            .map(scriptPath => {
                const script = this._scriptsByUrl.get(scriptPath);

                const displayPath = this.realPathToDisplayPath(scriptPath);
                const basename = path.basename(displayPath);
                return <ILoadedScript>{
                    label: basename,
                    description: displayPath === basename ? '' : displayPath,
                    source: {
                        name: basename,
                        path: displayPath,
                        sourceReference: this.getSourceReferenceForScriptId(script.scriptId)
                    }
                };
            })
            .sort((a, b) => a.label.localeCompare(b.label));

        return { loadedScripts };
    }

    private resolvePendingBreakpoint(pendingBP: IPendingBreakpoint): Promise<void> {
        return this.setBreakpoints(pendingBP.args, pendingBP.requestSeq, pendingBP.ids).then(response => {
            response.breakpoints.forEach((bp, i) => {
                bp.id = pendingBP.ids[i];
                this._session.sendEvent(new BreakpointEvent('new', bp));
            });
        });
    }

    protected onBreakpointResolved(params: Crdp.Debugger.BreakpointResolvedEvent): void {
        const script = this._scriptsById.get(params.location.scriptId);
        if (!script) {
            // Breakpoint resolved for a script we don't know about
            return;
        }

        const committedBps = this._committedBreakpointsByUrl.get(script.url) || [];
        committedBps.push(params.breakpointId);
        this._committedBreakpointsByUrl.set(script.url, committedBps);

        const bp = <DebugProtocol.Breakpoint>{
            id: this._breakpointIdHandles.lookup(params.breakpointId),
            verified: true,
            line: params.location.lineNumber,
            column: params.location.columnNumber
        };
        const scriptPath = this._pathTransformer.breakpointResolved(bp, script.url);
        this._sourceMapTransformer.breakpointResolved(bp, scriptPath);
        this._lineColTransformer.breakpointResolved(bp);
        this._session.sendEvent(new BreakpointEvent('new', bp));
    }

    protected onConsoleAPICalled(params: Crdp.Runtime.ConsoleAPICalledEvent): void {
        const result = formatConsoleArguments(params);
        if (result) {
            const category = result.isError ? 'stderr' : 'stdout';
            this.logObjects(result.args, category);
        }
    }

    private logObjects(objs: Crdp.Runtime.RemoteObject[], category: string): void {
        // Shortcut the common log case to reduce unnecessary back and forth
        if (objs.length === 1 && objs[0].type === 'string') {
            const e = new OutputEvent(objs[0].value + '\n', category);
            this._session.sendEvent(e);
            return;
        }

        const e: DebugProtocol.OutputEvent = new OutputEvent('output', category);
        e.body.variablesReference = this._variableHandles.create(new variables.LoggedObjects(objs), 'repl');
        this._session.sendEvent(e);
    }

    protected onExceptionThrown(params: Crdp.Runtime.ExceptionThrownEvent): void {
        const formattedException = formatExceptionDetails(params.exceptionDetails);
        this.mapFormattedException(formattedException).then(exceptionStr => {
            this._session.sendEvent(new OutputEvent(
                exceptionStr + '\n',
                'stderr'
            ));
        });
    }

    // We parse stack trace from `formattedException`, source map it and return a new string
    protected async mapFormattedException(formattedException: string): Promise<string> {
        const exceptionLines = formattedException.split(/\r?\n/);

        for (let i = 0, len = exceptionLines.length; i < len; ++i) {
            const line = exceptionLines[i];
            const matches = line.match(/^\s+at (.*?)\s*\(?([^ ]+):(\d+):(\d+)\)?$/);

            if (!matches) continue;
            const linePath = matches[2];
            const lineNum = parseInt(matches[3], 10);
            const adjustedLineNum = lineNum - 1;
            const columnNum = parseInt(matches[4], 10);
            const clientPath = this._pathTransformer.getClientPathFromTargetPath(linePath);
            const mapped = await this._sourceMapTransformer.mapToAuthored(clientPath || linePath, adjustedLineNum, columnNum);

            if (mapped && mapped.source && utils.isNumber(mapped.line) && utils.isNumber(mapped.column)) {
                this._lineColTransformer.mappedExceptionStack(mapped);
                exceptionLines[i] = exceptionLines[i].replace(
                    `${linePath}:${lineNum}:${columnNum}`,
                    `${mapped.source}:${mapped.line}:${mapped.column}`);
            } else if (clientPath && clientPath !== linePath) {
                const location = { line: adjustedLineNum, column: columnNum };
                this._lineColTransformer.mappedExceptionStack(location);
                exceptionLines[i] = exceptionLines[i].replace(
                    `${linePath}:${lineNum}:${columnNum}`,
                    `${clientPath}:${location.line}:${location.column}`);
            }
        }

        return exceptionLines.join('\n');
    }

    /**
     * For backcompat, also listen to Console.messageAdded, only if it looks like the old format.
     */
    protected onMessageAdded(params: any): void {
        // message.type is undefined when Runtime.consoleAPICalled is being sent
        if (params && params.message && params.message.type) {
            const onConsoleAPICalledParams: Crdp.Runtime.ConsoleAPICalledEvent = {
                type: params.message.type,
                timestamp: params.message.timestamp,
                args: params.message.parameters || [{ type: 'string', value: params.message.text }],
                stackTrace: params.message.stack,
                executionContextId: 1
            };
            this.onConsoleAPICalled(onConsoleAPICalledParams);
        }
    }

    public disconnect(): void {
        this.shutdown();
        return this.terminateSession('Got disconnect request');
    }

    public setBreakpoints(args: ISetBreakpointsArgs, requestSeq: number, ids?: number[]): Promise<ISetBreakpointsResponseBody> {
        this.reportBpTelemetry(args);
        if (args.source.path) {
            args.source.path = this.displayPathToRealPath(args.source.path);
        }

        return this.validateBreakpointsPath(args)
            .then(() => {
                this._lineColTransformer.setBreakpoints(args);
                this._sourceMapTransformer.setBreakpoints(args, requestSeq);
                this._pathTransformer.setBreakpoints(args);

                // Get the target url of the script
                let targetScriptUrl: string;
                if (args.source.sourceReference) {
                    const handle = this._sourceHandles.get(args.source.sourceReference);
                    if (!handle.scriptId && args.source.path) {
                        // A sourcemapped script with inline sources won't have a scriptId here, but the
                        // source.path has been fixed.
                        targetScriptUrl = args.source.path;
                    } else {
                        const targetScript = this._scriptsById.get(handle.scriptId);
                        if (targetScript) {
                            targetScriptUrl = targetScript.url;
                        }
                    }
                } else if (args.source.path) {
                    targetScriptUrl = args.source.path;
                }

                if (targetScriptUrl) {
                    // DebugProtocol sends all current breakpoints for the script. Clear all breakpoints for the script then add all of them
                    const setBreakpointsPFailOnError = this._setBreakpointsRequestQ
                        .then(() => this.clearAllBreakpoints(targetScriptUrl))
                        .then(() => this.addBreakpoints(targetScriptUrl, args.breakpoints))
                        .then(responses => ({ breakpoints: this.targetBreakpointResponsesToClientBreakpoints(targetScriptUrl, responses, args.breakpoints, ids) }));

                    const setBreakpointsPTimeout = utils.promiseTimeout(setBreakpointsPFailOnError, ChromeDebugAdapter.SET_BREAKPOINTS_TIMEOUT, localize('setBPTimedOut', "Set breakpoints request timed out"));

                    // Do just one setBreakpointsRequest at a time to avoid interleaving breakpoint removed/breakpoint added requests to Crdp, which causes issues.
                    // Swallow errors in the promise queue chain so it doesn't get blocked, but return the failing promise for error handling.
                    this._setBreakpointsRequestQ = setBreakpointsPTimeout.catch(e => {
                        // Log the timeout, but any other error will be logged elsewhere
                        if (e.message && e.message.indexOf('timed out') >= 0) {
                            logger.error(e.stack);
                        }
                    });

                    // Return the setBP request, no matter how long it takes. It may take awhile in Node 7.5 - 7.7, see https://github.com/nodejs/node/issues/11589
                    return setBreakpointsPFailOnError.then(body => {
                        this._sourceMapTransformer.setBreakpointsResponse(body, requestSeq);
                        this._lineColTransformer.setBreakpointsResponse(body);
                        return body;
                    });
                } else {
                    return Promise.resolve(this.unverifiedBpResponse(args, requestSeq, localize('bp.fail.noscript', "Can't find script for breakpoint request")));
                }
            },
            e => this.unverifiedBpResponse(args, requestSeq, e.message));
    }

    private reportBpTelemetry(args: ISetBreakpointsArgs): void {
        let fileExt = '';
        if (args.source.path) {
            fileExt = path.extname(args.source.path);
        }

        telemetry.reportEvent('setBreakpointsRequest', { fileExt });
    }

    private validateBreakpointsPath(args: ISetBreakpointsArgs): Promise<void> {
        if (!args.source.path || args.source.sourceReference) return Promise.resolve();

        return this._sourceMapTransformer.getGeneratedPathFromAuthoredPath(args.source.path).then<void>(mappedPath => {
            if (!mappedPath) {
                return utils.errP(localize('validateBP.sourcemapFail', "Breakpoint ignored because generated code not found (source map problem?)."));
            }

            const targetPath = this._pathTransformer.getTargetPathFromClientPath(mappedPath);
            if (!targetPath) {
                return utils.errP(localize('validateBP.notFound', "Breakpoint ignored because target path not found"));
            }

            return undefined;
        });
    }

    private unverifiedBpResponse(args: ISetBreakpointsArgs, requestSeq: number, message?: string): ISetBreakpointsResponseBody {
        const breakpoints = args.breakpoints.map(bp => {
            return <DebugProtocol.Breakpoint>{
                verified: false,
                line: bp.line,
                column: bp.column,
                message,
                id: this._breakpointIdHandles.create(this._nextUnboundBreakpointId++ + '')
            };
        });

        if (args.source.path) {
            const ids = breakpoints.map(bp => bp.id);
            this._pendingBreakpointsByUrl.set(args.source.path, { args, ids, requestSeq });
        }

        return { breakpoints };
    }

    private clearAllBreakpoints(url: string): Promise<void> {
        if (!this._committedBreakpointsByUrl.has(url)) {
            return Promise.resolve();
        }

        // Remove breakpoints one at a time. Seems like it would be ok to send the removes all at once,
        // but there is a chrome bug where when removing 5+ or so breakpoints at once, it gets into a weird
        // state where later adds on the same line will fail with 'breakpoint already exists' even though it
        // does not break there.
        return this._committedBreakpointsByUrl.get(url).reduce((p, breakpointId) => {
            return p.then(() => this.chrome.Debugger.removeBreakpoint({ breakpointId })).then(() => { });
        }, Promise.resolve()).then(() => {
            this._committedBreakpointsByUrl.delete(url);
        });
    }

    /**
     * Makes the actual call to either Debugger.setBreakpoint or Debugger.setBreakpointByUrl, and returns the response.
     * Responses from setBreakpointByUrl are transformed to look like the response from setBreakpoint, so they can be
     * handled the same.
     */
    protected addBreakpoints(url: string, breakpoints: DebugProtocol.SourceBreakpoint[]): Promise<ISetBreakpointResult[]> {
        let responsePs: Promise<ISetBreakpointResult>[];
        if (url.startsWith(ChromeDebugAdapter.EVAL_NAME_PREFIX)) {
            // eval script with no real url - use debugger_setBreakpoint
            const scriptId: Crdp.Runtime.ScriptId = utils.lstrip(url, ChromeDebugAdapter.EVAL_NAME_PREFIX);
            responsePs = breakpoints.map(({ line, column = 0, condition }, i) => this.chrome.Debugger.setBreakpoint({ location: { scriptId, lineNumber: line, columnNumber: column }, condition }));
        } else {
            // script that has a url - use debugger_setBreakpointByUrl so that Chrome will rebind the breakpoint immediately
            // after refreshing the page. This is the only way to allow hitting breakpoints in code that runs immediately when
            // the page loads.
            const script = this.getScriptByUrl(url);
            const urlRegex = utils.pathToRegex(url);
            responsePs = breakpoints.map(({ line, column = 0, condition }, i) => {
                return this.addOneBreakpointByUrl(script && script.scriptId, urlRegex, line, column, condition);
            });
        }

        // Join all setBreakpoint requests to a single promise
        return Promise.all(responsePs);
    }

    private async addOneBreakpointByUrl(scriptId: Crdp.Runtime.ScriptId | undefined, urlRegex: string, lineNumber: number, columnNumber: number, condition: string): Promise<ISetBreakpointResult> {
        let bpLocation = { lineNumber, columnNumber };
        if (this._columnBreakpointsEnabled && scriptId) { // scriptId undefined when script not yet loaded, can't fix up column BP :(
            try {
                const possibleBpResponse = await this.chrome.Debugger.getPossibleBreakpoints({
                    start: { scriptId, lineNumber, columnNumber: 0 },
                    end: { scriptId, lineNumber: lineNumber + 1, columnNumber: 0 },
                    restrictToFunction: false });
                if (possibleBpResponse.locations.length) {
                    const selectedLocation = ChromeUtils.selectBreakpointLocation(lineNumber, columnNumber, possibleBpResponse.locations);
                    bpLocation = { lineNumber: selectedLocation.lineNumber, columnNumber: selectedLocation.columnNumber || 0 };
                }
            } catch (e) {
                // getPossibleBPs not supported
            }
        }

        let result;
        try {
            result = await this.chrome.Debugger.setBreakpointByUrl({ urlRegex, lineNumber: bpLocation.lineNumber, columnNumber: bpLocation.columnNumber, condition });
        } catch (e) {
            if (e.message === "Breakpoint at specified location already exists.") {
                return {
                    actualLocation: { lineNumber: bpLocation.lineNumber, columnNumber: bpLocation.columnNumber, scriptId }
                };
            } else {
                throw e;
            }
        }

        // Now convert the response to a SetBreakpointResponse so both response types can be handled the same
        const locations = result.locations;
        return <Crdp.Debugger.SetBreakpointResponse>{
            breakpointId: result.breakpointId,
            actualLocation: locations[0] && {
                lineNumber: locations[0].lineNumber,
                columnNumber: locations[0].columnNumber,
                scriptId
            }
        };
    }

    private targetBreakpointResponsesToClientBreakpoints(url: string, responses: ISetBreakpointResult[], requestBps: DebugProtocol.SourceBreakpoint[], ids?: number[]): DebugProtocol.Breakpoint[] {
        // Don't cache errored responses
        const committedBpIds = responses
            .filter(response => response && response.breakpointId)
            .map(response => response.breakpointId);

        // Cache successfully set breakpoint ids from chrome in committedBreakpoints set
        this._committedBreakpointsByUrl.set(url, committedBpIds);

        // Map committed breakpoints to DebugProtocol response breakpoints
        return responses
            .map((response, i) => {
                // The output list needs to be the same length as the input list, so map errors to
                // unverified breakpoints.
                if (!response) {
                    return <DebugProtocol.Breakpoint>{
                        verified: false
                    };
                }

                // response.breakpointId is undefined when no target BP is backing this BP, e.g. it's at the same location
                // as another BP
                const responseBpId = response.breakpointId || (this._nextUnboundBreakpointId++ + '');

                let bpId: number;
                if (ids && ids[i]) {
                    // IDs passed in for previously unverified BPs
                    bpId = ids[i];
                    this._breakpointIdHandles.set(bpId, responseBpId);
                } else {
                    bpId = this._breakpointIdHandles.lookup(responseBpId) ||
                        this._breakpointIdHandles.create(responseBpId);
                }

                if (!response.actualLocation) {
                    return <DebugProtocol.Breakpoint>{
                        id: bpId,
                        verified: false
                    };
                }

                const thisBpRequest = requestBps[i];
                if (thisBpRequest.hitCondition) {
                    if (!this.addHitConditionBreakpoint(thisBpRequest, response)) {
                        return <DebugProtocol.Breakpoint>{
                            id: bpId,
                            message: localize('invalidHitCondition', "Invalid hit condition: {0}", thisBpRequest.hitCondition),
                            verified: false
                        };
                    }
                }

                return <DebugProtocol.Breakpoint>{
                    id: bpId,
                    verified: true,
                    line: response.actualLocation.lineNumber,
                    column: response.actualLocation.columnNumber
                };
            });
    }

    private addHitConditionBreakpoint(requestBp: DebugProtocol.SourceBreakpoint, response: ISetBreakpointResult): boolean {
        const result = ChromeDebugAdapter.HITCONDITION_MATCHER.exec(requestBp.hitCondition.trim());
        if (result && result.length >= 3) {
            let op = result[1] || '>=';
            if (op === '=') op = '==';
            const value = result[2];
            const expr = op === '%'
                ? `return (numHits % ${value}) === 0;`
                : `return numHits ${op} ${value};`;

            // eval safe because of the regex, and this is only a string that the current user will type in
            /* tslint:disable:no-function-constructor-with-string-args */
            const shouldPause: (numHits: number) => boolean = <any>new Function('numHits', expr);
            /* tslint:enable:no-function-constructor-with-string-args */
            this._hitConditionBreakpointsById.set(response.breakpointId, { numHits: 0, shouldPause });
            return true;
        } else {
            return false;
        }
    }

    public setExceptionBreakpoints(args: DebugProtocol.SetExceptionBreakpointsArguments): Promise<void> {
        let state: 'all' | 'uncaught' | 'none';
        if (args.filters.indexOf('all') >= 0) {
            state = 'all';
        } else if (args.filters.indexOf('uncaught') >= 0) {
            state = 'uncaught';
        } else {
            state = 'none';
        }

        return this.chrome.Debugger.setPauseOnExceptions({ state })
            .then(() => { });
    }

    /**
     * internal -> suppress telemetry
     */
    public continue(internal = false): Promise<void> {
        if (!internal) telemetry.reportEvent('continueRequest');
        if (!this.chrome) {
            return utils.errP(errors.runtimeNotConnectedMsg);
        }

        this._expectingResumedEvent = true;
        return this._currentStep = this.chrome.Debugger.resume()
            .then(() => { });
    }

    public next(): Promise<void> {
        if (!this.chrome) {
            return utils.errP(errors.runtimeNotConnectedMsg);
        }

        telemetry.reportEvent('nextRequest');
        this._expectingStopReason = 'step';
        this._expectingResumedEvent = true;
        return this._currentStep = this.chrome.Debugger.stepOver()
            .then(() => { });
    }

    public stepIn(): Promise<void> {
        if (!this.chrome) {
            return utils.errP(errors.runtimeNotConnectedMsg);
        }

        telemetry.reportEvent('stepInRequest');
        this._expectingStopReason = 'step';
        this._expectingResumedEvent = true;
        return this._currentStep = this.chrome.Debugger.stepInto()
            .then(() => { });
    }

    public stepOut(): Promise<void> {
        if (!this.chrome) {
            return utils.errP(errors.runtimeNotConnectedMsg);
        }

        telemetry.reportEvent('stepOutRequest');
        this._expectingStopReason = 'step';
        this._expectingResumedEvent = true;
        return this._currentStep = this.chrome.Debugger.stepOut()
            .then(() => { });
    }

    public stepBack(): Promise<void> {
        return (<TimeTravelRuntime>this.chrome).TimeTravel.stepBack();
    }

    protected reverseContinue(): Promise<void> {
        return (<TimeTravelRuntime>this.chrome).TimeTravel.reverse();
    }

    public pause(): Promise<void> {
        if (!this.chrome) {
            return utils.errP(errors.runtimeNotConnectedMsg);
        }

        telemetry.reportEvent('pauseRequest');
        this._expectingStopReason = 'pause';
        return this._currentStep = this.chrome.Debugger.pause()
            .then(() => { });
    }

    public async stackTrace(args: DebugProtocol.StackTraceArguments): Promise<IStackTraceResponseBody> {
        if (!this._currentPauseNotification) {
            return Promise.reject(errors.noCallStackAvailable());
        }

        let stackFrames = this._currentPauseNotification.callFrames.map(frame => this.callFrameToStackFrame(frame))
            .concat(this.asyncFrames(this._currentPauseNotification.asyncStackTrace));

        const totalFrames = stackFrames.length;
        if (typeof args.startFrame === 'number') {
            stackFrames = stackFrames.slice(args.startFrame);
        }

        if (typeof args.levels === 'number') {
            stackFrames = stackFrames.slice(0, args.levels);
        }

        const stackTraceResponse: IInternalStackTraceResponseBody = {
            stackFrames,
            totalFrames
        };
        this._pathTransformer.stackTraceResponse(stackTraceResponse);
        this._sourceMapTransformer.stackTraceResponse(stackTraceResponse);
        this._lineColTransformer.stackTraceResponse(stackTraceResponse);

        await Promise.all(stackTraceResponse.stackFrames.map(async (frame, i) => {
            // Remove isSourceMapped to convert back to DebugProtocol.StackFrame
            const isSourceMapped = frame.isSourceMapped;
            delete frame.isSourceMapped;

            if (!frame.source) {
                return;
            }

            // Apply hints to skipped frames
            const getSkipReason = reason => localize('skipReason', "(skipped by '{0}')", reason);
            if (frame.source.path && this.shouldSkipSource(frame.source.path)) {
                frame.source.origin = (frame.source.origin ? frame.source.origin + ' ' : '') + getSkipReason('skipFiles');
                frame.source.presentationHint = 'deemphasize';
            } else if (this.smartStepEnabled() && !isSourceMapped) {
                frame.source.origin = (frame.source.origin ? frame.source.origin + ' ' : '') + getSkipReason('smartStep');
                frame.source.presentationHint = 'deemphasize';
            }

            // Allow consumer to adjust final path
            if (frame.source.path && frame.source.sourceReference) {
                frame.source.path = this.realPathToDisplayPath(frame.source.path);
            }

            // And finally, remove the fake eval path and fix the name, if it was never resolved to a real path
            if (frame.source.path && frame.source.path.startsWith(ChromeDebugAdapter.EVAL_NAME_PREFIX)) {
                frame.source.path = undefined;
                frame.source.name = this.displayNameForSourceReference(frame.source.sourceReference);
            }
        }));

        return stackTraceResponse;
    }

    private asyncFrames(stackTrace: Crdp.Runtime.StackTrace): DebugProtocol.StackFrame[] {
        if (stackTrace) {
            const frames = stackTrace.callFrames
                .map(frame => this.runtimeCFToDebuggerCF(frame))
                .map(frame => this.callFrameToStackFrame(frame));

            frames.unshift({
                id: this._frameHandles.create(null),
                name: `[ ${stackTrace.description} ]`,
                source: undefined,
                line: undefined,
                column: undefined,
                presentationHint: 'label'
            });

            return frames.concat(this.asyncFrames(stackTrace.parent));
        } else {
            return [];
        }
    }

    private runtimeCFToDebuggerCF(frame: Crdp.Runtime.CallFrame): Crdp.Debugger.CallFrame {
        return {
            callFrameId: undefined,
            scopeChain: undefined,
            this: undefined,
            location: {
                lineNumber: frame.lineNumber,
                columnNumber: frame.columnNumber,
                scriptId: frame.scriptId
            },
            functionName: frame.functionName
        };
    }

    private callFrameToStackFrame(frame: Crdp.Debugger.CallFrame): DebugProtocol.StackFrame {
        const { location, functionName } = frame;
        const line = location.lineNumber;
        const column = location.columnNumber;
        const script = this._scriptsById.get(location.scriptId);

        try {
            // When the script has a url and isn't one we're ignoring, send the name and path fields. PathTransformer will
            // attempt to resolve it to a script in the workspace. Otherwise, send the name and sourceReference fields.
            const sourceReference = this.getSourceReferenceForScriptId(script.scriptId);
            const origin = this.getReadonlyOrigin(script.url);
            const source: DebugProtocol.Source = {
                name: path.basename(script.url),
                path: script.url,
                sourceReference,
                origin
            };

            // If the frame doesn't have a function name, it's either an anonymous function
            // or eval script. If its source has a name, it's probably an anonymous function.
            const frameName = functionName || (script.url ? '(anonymous function)' : '(eval code)');
            return {
                id: this._frameHandles.create(frame),
                name: frameName,
                source,
                line: line,
                column
            };
        } catch (e) {
            // Some targets such as the iOS simulator behave badly and return nonsense callFrames.
            // In these cases, return a dummy stack frame
            const evalUnknown = `${ChromeDebugAdapter.EVAL_NAME_PREFIX}_Unknown`;
            return {
                id: this._frameHandles.create(<any>{ }),
                name: evalUnknown,
                source: { name: evalUnknown, path: evalUnknown },
                line,
                column
            };
        }
    }

    protected getReadonlyOrigin(url: string): string {
        // To override
        return undefined;
    }

    /**
     * Called when returning a stack trace, for the path for Sources that have a sourceReference, so consumers can
     * tweak it, since it's only for display.
     */
    protected realPathToDisplayPath(realPath: string): string {
        // To override
        return realPath;
    }

    protected displayPathToRealPath(displayPath: string): string {
        return displayPath;
    }

    /**
     * Get the existing handle for this script, identified by runtime scriptId, or create a new one
     */
    private getSourceReferenceForScriptId(scriptId: Crdp.Runtime.ScriptId): number {
        return this._sourceHandles.lookupF(container => container.scriptId === scriptId) ||
            this._sourceHandles.create({ scriptId });
    }

    public scopes(args: DebugProtocol.ScopesArguments): IScopesResponseBody {
        const currentFrame = this._frameHandles.get(args.frameId);
        if (!currentFrame || !currentFrame.location || !currentFrame.callFrameId) {
            throw errors.stackFrameNotValid();
        }

        if (!currentFrame.callFrameId) {
            return { scopes: [] };
        }

        const currentScript = this._scriptsById.get(currentFrame.location.scriptId);
        const currentScriptUrl = currentScript && currentScript.url;
        const currentScriptPath = (currentScriptUrl && this._pathTransformer.getClientPathFromTargetPath(currentScriptUrl)) || currentScriptUrl;

        const scopes = currentFrame.scopeChain.map((scope: Crdp.Debugger.Scope, i: number) => {
            // The first scope should include 'this'. Keep the RemoteObject reference for use by the variables request
            const thisObj = i === 0 && currentFrame.this;
            const returnValue = i === 0 && currentFrame.returnValue;
            const variablesReference = this._variableHandles.create(
                new ScopeContainer(currentFrame.callFrameId, i, scope.object.objectId, thisObj, returnValue));

            const resultScope = <DebugProtocol.Scope>{
                name: scope.type.substr(0, 1).toUpperCase() + scope.type.substr(1), // Take Chrome's scope, uppercase the first letter
                variablesReference,
                expensive: scope.type === 'global'
            };

            if (scope.startLocation && scope.endLocation) {
                resultScope.column = scope.startLocation.columnNumber;
                resultScope.line = scope.startLocation.lineNumber;
                resultScope.endColumn = scope.endLocation.columnNumber;
                resultScope.endLine = scope.endLocation.lineNumber;
            }

            return resultScope;
        });

        if (this._exception) {
            scopes.unshift(<DebugProtocol.Scope>{
                name: localize('scope.exception', "Exception"),
                variablesReference: this._variableHandles.create(ExceptionContainer.create(this._exception))
            });
        }

        const scopesResponse = { scopes };
        if (currentScriptPath) {
            this._sourceMapTransformer.scopesResponse(currentScriptPath, scopesResponse);
            this._lineColTransformer.scopeResponse(scopesResponse);
        }

        return scopesResponse;
    }

    public variables(args: DebugProtocol.VariablesArguments): Promise<IVariablesResponseBody> {
        if (!this.chrome) {
            return utils.errP(errors.runtimeNotConnectedMsg);
        }

        const handle = this._variableHandles.get(args.variablesReference);
        if (!handle) {
            return Promise.resolve<IVariablesResponseBody>(undefined);
        }

        return handle.expand(this, args.filter, args.start, args.count)
            .catch(err => {
                logger.log('Error handling variables request: ' + err.toString());
                return [];
            }).then(variables => {
                return { variables };
            });
    }

    public propertyDescriptorToVariable(propDesc: Crdp.Runtime.PropertyDescriptor, owningObjectId?: string, parentEvaluateName?: string): Promise<DebugProtocol.Variable> {
        if (propDesc.get) {
            // Getter
            const grabGetterValue = 'function remoteFunction(propName) { return this[propName]; }';
            return this.chrome.Runtime.callFunctionOn({
                objectId: owningObjectId,
                functionDeclaration: grabGetterValue,
                arguments: [{ value: propDesc.name }]
            }).then(response => {
                if (response.exceptionDetails) {
                    // Not an error, getter could be `get foo() { throw new Error('bar'); }`
                    const exceptionMessage = ChromeUtils.errorMessageFromExceptionDetails(response.exceptionDetails);
                    logger.verbose('Exception thrown evaluating getter - ' + exceptionMessage);
                    return { name: propDesc.name, value: exceptionMessage, variablesReference: 0 };
                } else {
                    return this.remoteObjectToVariable(propDesc.name, response.result, parentEvaluateName);
                }
            },
            error => {
                logger.error('Error evaluating getter - ' + error.toString());
                return { name: propDesc.name, value: error.toString(), variablesReference: 0 };
            });
        } else if (propDesc.set) {
            // setter without a getter, unlikely
            return Promise.resolve({ name: propDesc.name, value: 'setter', variablesReference: 0 });
        } else {
            // Non getter/setter
            return this.internalPropertyDescriptorToVariable(propDesc, parentEvaluateName);
        }
    }

    public getVariablesForObjectId(objectId: string, evaluateName?: string, filter?: string, start?: number, count?: number): Promise<DebugProtocol.Variable[]> {
        if (typeof start === 'number' && typeof count === 'number') {
            return this.getFilteredVariablesForObject(objectId, evaluateName, filter, start, count);
        }

        filter = filter === 'indexed' ? 'all' : filter;

        return Promise.all([
            // Need to make two requests to get all properties
            this.getRuntimeProperties({ objectId, ownProperties: false, accessorPropertiesOnly: true, generatePreview: true }),
            this.getRuntimeProperties({ objectId, ownProperties: true, accessorPropertiesOnly: false, generatePreview: true })
        ]).then(getPropsResponses => {
            // Sometimes duplicates will be returned - merge all descriptors by name
            const propsByName = new Map<string, Crdp.Runtime.PropertyDescriptor>();
            const internalPropsByName = new Map<string, Crdp.Runtime.InternalPropertyDescriptor>();
            getPropsResponses.forEach(response => {
                if (response) {
                    response.result.forEach(propDesc =>
                        propsByName.set(propDesc.name, propDesc));

                    if (response.internalProperties) {
                        response.internalProperties.forEach(internalProp => {
                            internalPropsByName.set(internalProp.name, internalProp);
                        });
                    }
                }
            });

            // Convert Chrome prop descriptors to DebugProtocol vars
            const variables: Promise<DebugProtocol.Variable>[] = [];
            propsByName.forEach(propDesc => {
                if (!filter || filter === 'all' || (isIndexedPropName(propDesc.name) === (filter === 'indexed'))) {
                    variables.push(this.propertyDescriptorToVariable(propDesc, objectId, evaluateName));
                }
            });

            internalPropsByName.forEach(internalProp => {
                if (!filter || filter === 'all' || (isIndexedPropName(internalProp.name) === (filter === 'indexed'))) {
                    variables.push(Promise.resolve(this.internalPropertyDescriptorToVariable(internalProp, evaluateName)));
                }
            });

            return Promise.all(variables);
        }).then(variables => {
            // Sort all variables properly
            return variables.sort((var1, var2) => ChromeUtils.compareVariableNames(var1.name, var2.name));
        });
    }

    private getRuntimeProperties(params: Crdp.Runtime.GetPropertiesRequest): Promise<Crdp.Runtime.GetPropertiesResponse> {
        return this.chrome.Runtime.getProperties(params)
            .catch(err => {
                if (err.message.startsWith('Cannot find context with specified id')) {
                    // Hack to ignore this error until we fix https://github.com/Microsoft/vscode/issues/18001 to not request variables at unexpected times.
                    return null;
                } else {
                    throw err;
                }
            });
    }

    private internalPropertyDescriptorToVariable(propDesc: Crdp.Runtime.InternalPropertyDescriptor, parentEvaluateName: string): Promise<DebugProtocol.Variable> {
        return this.remoteObjectToVariable(propDesc.name, propDesc.value, parentEvaluateName);
    }

    private getFilteredVariablesForObject(objectId: string, evaluateName: string, filter: string, start: number, count: number): Promise<DebugProtocol.Variable[]> {
        // No ES6, in case we talk to an old runtime
        const getIndexedVariablesFn = `
            function getIndexedVariables(start, count) {
                var result = [];
                for (var i = start; i < (start + count); i++) result[i] = this[i];
                return result;
            }`;
        // TODO order??
        const getNamedVariablesFn = `
            function getNamedVariablesFn(start, count) {
                var result = [];
                var ownProps = Object.getOwnPropertyNames(this);
                for (var i = start; i < (start + count); i++) result[i] = ownProps[i];
                return result;
            }`;

        const getVarsFn = filter === 'indexed' ? getIndexedVariablesFn : getNamedVariablesFn;
        return this.getFilteredVariablesForObjectId(objectId, evaluateName, getVarsFn, filter, start, count);
    }

    private getFilteredVariablesForObjectId(objectId: string, evaluateName: string, getVarsFn: string, filter: string, start: number, count: number): Promise<DebugProtocol.Variable[]> {
        return this.chrome.Runtime.callFunctionOn({
            objectId,
            functionDeclaration: getVarsFn,
            arguments: [{ value: start }, { value: count }],
            silent: true
        }).then<DebugProtocol.Variable[]>(evalResponse => {
            if (evalResponse.exceptionDetails) {
                const errMsg = ChromeUtils.errorMessageFromExceptionDetails(evalResponse.exceptionDetails);
                return Promise.reject(errors.errorFromEvaluate(errMsg));
            } else {
                // The eval was successful and returned a reference to the array object. Get the props, then filter
                // out everything except the index names.
                return this.getVariablesForObjectId(evalResponse.result.objectId, evaluateName, filter)
                    .then(variables => variables.filter(variable => isIndexedPropName(variable.name)));
            }
        },
        error => Promise.reject(errors.errorFromEvaluate(error.message)));
    }

    public source(args: DebugProtocol.SourceArguments): Promise<ISourceResponseBody> {
        let scriptId: Crdp.Runtime.ScriptId;
        if (args.sourceReference) {
            const handle = this._sourceHandles.get(args.sourceReference);
            if (!handle) {
                return Promise.reject(errors.sourceRequestIllegalHandle());
            }

            // Have inlined content?
            if (handle.contents) {
                return Promise.resolve({
                    content: handle.contents
                });
            }

            scriptId = handle.scriptId;
        } else if (args.source && args.source.path) {
            const escapedPath = encodeURI(this.displayPathToRealPath(args.source.path)); // Request path has chars unescaped, but they should be escaped in scriptsByUrl
            const script = this._scriptsByUrl.get(escapedPath);
            if (!script) {
                return Promise.reject(errors.sourceRequestCouldNotRetrieveContent());
            }

            scriptId = script.scriptId;
        }

        if (!scriptId) {
            return Promise.reject(errors.sourceRequestCouldNotRetrieveContent());
        }

        // If not, should have scriptId
        return this.chrome.Debugger.getScriptSource({ scriptId }).then(response => {
            return {
                content: response.scriptSource,
                mimeType: 'text/javascript'
            };
        });
    }

    public threads(): IThreadsResponseBody {
        return {
            threads: [
                {
                    id: ChromeDebugAdapter.THREAD_ID,
                    name: this.threadName()
                }
            ]
        };
    }

    protected threadName(): string {
        return 'Thread ' + ChromeDebugAdapter.THREAD_ID;
    }

    public async evaluate(args: DebugProtocol.EvaluateArguments): Promise<IEvaluateResponseBody> {
        if (!this.chrome) {
            return utils.errP(errors.runtimeNotConnectedMsg);
        }

        if (args.expression.startsWith(ChromeDebugAdapter.SCRIPTS_COMMAND)) {
            return this.handleScriptsCommand(args);
        }

        const evalResponse = await this.waitThenDoEvaluate(args.expression, args.frameId, { generatePreview: true });

        // Convert to a Variable object then just copy the relevant fields off
        const variable = await this.remoteObjectToVariable('', evalResponse.result, /*parentEvaluateName=*/undefined, /*stringify=*/undefined, <VariableContext>args.context);
        if (evalResponse.exceptionDetails) {
            let resultValue = variable.value;
            if (resultValue && (resultValue.startsWith('ReferenceError: ') || resultValue.startsWith('TypeError: ')) && args.context !== 'repl') {
                resultValue = errors.evalNotAvailableMsg;
            }

            return utils.errP(resultValue);
        }

        return <IEvaluateResponseBody>{
            result: variable.value,
            variablesReference: variable.variablesReference,
            indexedVariables: variable.indexedVariables,
            namedVariables: variable.namedVariables
        };
    }

    /**
     * Handle the .scripts command, which can be used as `.scripts` to return a list of all script details,
     * or `.scripts <url>` to show the contents of the given script.
     */
    private handleScriptsCommand(args: DebugProtocol.EvaluateArguments): Promise<IEvaluateResponseBody> {
        let outputStringP: Promise<string>;
        const scriptsRest = utils.lstrip(args.expression, ChromeDebugAdapter.SCRIPTS_COMMAND).trim();
        if (scriptsRest) {
            // `.scripts <url>` was used, look up the script by url
            const requestedScript = this.getScriptByUrl(scriptsRest);
            if (requestedScript) {
                outputStringP = this.chrome.Debugger.getScriptSource({ scriptId: requestedScript.scriptId })
                    .then(result => {
                        const maxLength = 1e5;
                        return result.scriptSource.length > maxLength ?
                            result.scriptSource.substr(0, maxLength) + '[⋯]' :
                            result.scriptSource;
                    });
            } else {
                outputStringP = Promise.resolve(`No runtime script with url: ${scriptsRest}\n`);
            }
        } else {
            outputStringP = this.getAllScriptsString();
        }

        return outputStringP.then(scriptsStr => {
            this._session.sendEvent(new OutputEvent(scriptsStr));
            return <IEvaluateResponseBody>{
                result: '',
                variablesReference: 0
            };
        });
    }

    private getAllScriptsString(): Promise<string> {
        const runtimeScripts = Array.from(this._scriptsByUrl.keys())
            .sort();
        return Promise.all(runtimeScripts.map(script => this.getOneScriptString(script))).then(strs => {
            return strs.join('\n');
        });
    }

    private getOneScriptString(runtimeScriptPath: string): Promise<string> {
        let result = '› ' + runtimeScriptPath;
        const clientPath = this._pathTransformer.getClientPathFromTargetPath(runtimeScriptPath);
        if (clientPath && clientPath !== runtimeScriptPath) result += ` (${clientPath})`;

        return this._sourceMapTransformer.allSourcePathDetails(clientPath || runtimeScriptPath).then(sourcePathDetails => {
            let mappedSourcesStr = sourcePathDetails.map(details => `    - ${details.originalPath} (${details.inferredPath})`).join('\n');
            if (sourcePathDetails.length) mappedSourcesStr = '\n' + mappedSourcesStr;

            return result + mappedSourcesStr;
        });
    }

    /**
     * Allow consumers to override just because of https://github.com/nodejs/node/issues/8426
     */
    protected globalEvaluate(args: Crdp.Runtime.EvaluateRequest): Promise<Crdp.Runtime.EvaluateResponse> {
        return this.chrome.Runtime.evaluate(args);
    }

    private async waitThenDoEvaluate(expression: string, frameId?: number, extraArgs?: utils.Partial<Crdp.Runtime.EvaluateRequest>): Promise<Crdp.Debugger.EvaluateOnCallFrameResponse | Crdp.Runtime.EvaluateResponse> {
        const waitThenEval = this._waitAfterStep.then(() => this.doEvaluate(expression, frameId, extraArgs));
        this._waitAfterStep = waitThenEval.then(() => { }, () => { }); // to Promise<void> and handle failed evals
        return waitThenEval;

    }

    private async doEvaluate(expression: string, frameId?: number, extraArgs?: utils.Partial<Crdp.Runtime.EvaluateRequest>): Promise<Crdp.Debugger.EvaluateOnCallFrameResponse | Crdp.Runtime.EvaluateResponse> {
        if (typeof frameId === 'number') {
            const frame = this._frameHandles.get(frameId);
            if (!frame || !frame.callFrameId) {
                return utils.errP(errors.evalNotAvailableMsg);
            }

            const callFrameId = frame.callFrameId;
            let args: Crdp.Debugger.EvaluateOnCallFrameRequest = { callFrameId, expression, silent: true };
            if (extraArgs) {
                args = Object.assign(args, extraArgs);
            }

            return this.chrome.Debugger.evaluateOnCallFrame(args);
        } else {
            let args: Crdp.Runtime.EvaluateRequest = { expression, silent: true };
            if (extraArgs) {
                args = Object.assign(args, extraArgs);
            }

            return this.globalEvaluate(args);
        }
    }

    public setVariable(args: DebugProtocol.SetVariableArguments): Promise<ISetVariableResponseBody> {
        const handle = this._variableHandles.get(args.variablesReference);
        if (!handle) {
            return Promise.reject(errors.setValueNotSupported());
        }

        return handle.setValue(this, args.name, args.value)
            .then(value => ({ value }));
    }

    public setVariableValue(callFrameId: string, scopeNumber: number, variableName: string, value: string): Promise<string> {
        let evalResultObject: Crdp.Runtime.RemoteObject;
        return this.chrome.Debugger.evaluateOnCallFrame({ callFrameId, expression: value, silent: true }).then(evalResponse => {
            if (evalResponse.exceptionDetails) {
                const errMsg = ChromeUtils.errorMessageFromExceptionDetails(evalResponse.exceptionDetails);
                return Promise.reject(errors.errorFromEvaluate(errMsg));
            } else {
                evalResultObject = evalResponse.result;
                const newValue = ChromeUtils.remoteObjectToCallArgument(evalResultObject);
                return this.chrome.Debugger.setVariableValue({ callFrameId, scopeNumber, variableName, newValue });
            }
        },
        error => Promise.reject(errors.errorFromEvaluate(error.message)))
        // Temporary, Microsoft/vscode#12019
        .then(setVarResponse => ChromeUtils.remoteObjectToValue(evalResultObject).value);
    }

    public setPropertyValue(objectId: string, propName: string, value: string): Promise<string> {
        const setPropertyValueFn = `function() { return this["${propName}"] = ${value} }`;
        return this.chrome.Runtime.callFunctionOn({
            objectId, functionDeclaration: setPropertyValueFn,
            silent: true
        }).then(response => {
            if (response.exceptionDetails) {
                const errMsg = ChromeUtils.errorMessageFromExceptionDetails(response.exceptionDetails);
                return Promise.reject<string>(errors.errorFromEvaluate(errMsg));
            } else {
                // Temporary, Microsoft/vscode#12019
                return ChromeUtils.remoteObjectToValue(response.result).value;
            }
        },
        error => Promise.reject<string>(errors.errorFromEvaluate(error.message)));
    }

    public remoteObjectToVariable(name: string, object: Crdp.Runtime.RemoteObject, parentEvaluateName?: string, stringify = true, context: VariableContext = 'variables'): Promise<DebugProtocol.Variable> {
        name = name || '""';

        if (object) {
            if (object.type === 'object') {
                return this.createObjectVariable(name, object, parentEvaluateName, context);
            } else if (object.type === 'function') {
                return Promise.resolve(this.createFunctionVariable(name, object, context, parentEvaluateName));
            } else {
                return Promise.resolve(this.createPrimitiveVariable(name, object, parentEvaluateName, stringify));
            }
        } else {
            return Promise.resolve(this.createPrimitiveVariableWithValue(name, '', parentEvaluateName));
        }
    }

    public createFunctionVariable(name: string, object: Crdp.Runtime.RemoteObject, context: VariableContext, parentEvaluateName?: string): DebugProtocol.Variable {
        let value: string;
        const firstBraceIdx = object.description.indexOf('{');
        if (firstBraceIdx >= 0) {
            value = object.description.substring(0, firstBraceIdx) + '{ … }';
        } else {
            const firstArrowIdx = object.description.indexOf('=>');
            value = firstArrowIdx >= 0 ?
                object.description.substring(0, firstArrowIdx + 2) + ' …' :
                object.description;
        }

        const evaluateName = ChromeUtils.getEvaluateName(parentEvaluateName, name);
        return <DebugProtocol.Variable>{
            name,
            value,
            variablesReference: this._variableHandles.create(new PropertyContainer(object.objectId, evaluateName), context),
            type: value,
            evaluateName
        };
    }

    public createObjectVariable(name: string, object: Crdp.Runtime.RemoteObject, parentEvaluateName: string, context: VariableContext): Promise<DebugProtocol.Variable> {
        if ((<string>object.subtype) === 'internal#location') {
            // Could format this nicely later, see #110
            return Promise.resolve(this.createPrimitiveVariableWithValue(name, 'internal#location', parentEvaluateName));
        } else if (object.subtype === 'null') {
            return Promise.resolve(this.createPrimitiveVariableWithValue(name, 'null', parentEvaluateName));
        }

        const value = variables.getRemoteObjectPreview_object(object, context);
        let propCountP: Promise<IPropCount>;
        if (object.subtype === 'array' || object.subtype === 'typedarray') {
            if (object.preview && !object.preview.overflow) {
                propCountP = Promise.resolve(this.getArrayNumPropsByPreview(object));
            } else {
                propCountP = this.getArrayNumPropsByEval(object.objectId);
            }
        } else if (object.subtype === 'set' || object.subtype === 'map') {
            if (object.preview && !object.preview.overflow) {
                propCountP = Promise.resolve(this.getCollectionNumPropsByPreview(object));
            } else {
                propCountP = this.getCollectionNumPropsByEval(object.objectId);
            }
        } else {
            propCountP = Promise.resolve({
                indexedVariables: undefined,
                namedVariables: undefined
             });
        }

        const evaluateName = ChromeUtils.getEvaluateName(parentEvaluateName, name);
        const variablesReference = this._variableHandles.create(new PropertyContainer(object.objectId, evaluateName), context);
        return propCountP.then(({ indexedVariables, namedVariables }) => (<DebugProtocol.Variable>{
            name,
            value,
            type: value,
            variablesReference,
            indexedVariables,
            namedVariables,
            evaluateName
        }));
    }

    public createPrimitiveVariable(name: string, object: Crdp.Runtime.RemoteObject, parentEvaluateName?: string, stringify?: boolean): DebugProtocol.Variable {
        const value = variables.getRemoteObjectPreview_primitive(object, stringify);
        return this.createPrimitiveVariableWithValue(name, value, parentEvaluateName);
    }

    public createPrimitiveVariableWithValue(name: string, value: string, parentEvaluateName?: string): DebugProtocol.Variable {
        return {
            name,
            value,
            variablesReference: 0,
            evaluateName: ChromeUtils.getEvaluateName(parentEvaluateName, name)
        };
    }

    public async restartFrame(args: DebugProtocol.RestartFrameArguments): Promise<void> {
        const callFrame = this._frameHandles.get(args.frameId);
        if (!callFrame || !callFrame.callFrameId) {
            return utils.errP(errors.noRestartFrame);
        }

        await this.chrome.Debugger.restartFrame({ callFrameId: callFrame.callFrameId });
        this._expectingStopReason = 'frame_entry';
        return this.chrome.Debugger.stepInto();
    }

    public async completions(args: DebugProtocol.CompletionsArguments): Promise<ICompletionsResponseBody> {
        const text = args.text;
        const column = args.column;

        // 1-indexed column
        const prefix = text.substring(0, column - 1);

        let expression: string;
        const dot = prefix.lastIndexOf('.');
        if (dot >= 0) {
            expression = prefix.substr(0, dot);
        }

        if (expression) {
            logger.verbose(`Completions: Returning for expression '${expression}'`);
            const getCompletionsFn = `(function(x){var a=[];for(var o=x;o!==null&&typeof o !== 'undefined';o=o.__proto__){a.push(Object.getOwnPropertyNames(o))};return a})(${expression})`;
            const response = await this.waitThenDoEvaluate(getCompletionsFn, args.frameId, { returnByValue: true });
            if (response.exceptionDetails) {
                return { targets: [] };
            } else {
                return { targets: this.getFlatAndUniqueCompletionItems(response.result.value) };
            }
        } else {
            logger.verbose(`Completions: Returning global completions`);

            // If no expression was passed, we must be getting global completions at a breakpoint
            if (typeof args.frameId !== "number" || !this._frameHandles.get(args.frameId)) {
                return Promise.reject(errors.stackFrameNotValid());
            }

            const callFrame = this._frameHandles.get(args.frameId);
            if (!callFrame || !callFrame.callFrameId) {
                // Async frame or label
                return { targets: [] };
            }

            const scopeExpandPs = callFrame.scopeChain
                .map(scope => new ScopeContainer(callFrame.callFrameId, undefined, scope.object.objectId).expand(this));
            return Promise.all(scopeExpandPs)
                .then((variableArrs: DebugProtocol.Variable[][]) => {
                    const targets = this.getFlatAndUniqueCompletionItems(
                        variableArrs.map(variableArr => variableArr.map(variable => variable.name)));
                    return { targets };
                });
        }
    }

    private getFlatAndUniqueCompletionItems(arrays: string[][]): DebugProtocol.CompletionItem[] {
        const set = new Set<string>();
        const items: DebugProtocol.CompletionItem[] = [];

        for (let i = 0; i < arrays.length; i++) {
            for (let name of arrays[i]) {
                if (!isIndexedPropName(name) && !set.has(name)) {
                    set.add(name);
                    items.push({
                        label: <string>name,
                        type: 'property'
                    });
                }
            }
        }

        return items;
    }

    private getArrayNumPropsByEval(objectId: string): Promise<IPropCount> {
        // +2 for __proto__ and length
        const getNumPropsFn = `function() { return [this.length, Object.keys(this).length - this.length + 2]; }`;
        return this.getNumPropsByEval(objectId, getNumPropsFn);
    }

    private getArrayNumPropsByPreview(object: Crdp.Runtime.RemoteObject): IPropCount {
        let indexedVariables = 0;
        const indexedProps = object.preview.properties
            .filter(prop => isIndexedPropName(prop.name));
        if (indexedProps.length) {
            // +1 because (last index=0) => 1 prop
            indexedVariables = parseInt(indexedProps[indexedProps.length - 1].name, 10) + 1;
        }

        const namedVariables = object.preview.properties.length - indexedProps.length + 2; // 2 for __proto__ and length
        return { indexedVariables, namedVariables };
    }

    private getCollectionNumPropsByEval(objectId: string): Promise<IPropCount> {
        const getNumPropsFn = `function() { return [0, Object.keys(this).length + 1]; }`; // +1 for [[Entries]];
        return this.getNumPropsByEval(objectId, getNumPropsFn);
    }

    private getCollectionNumPropsByPreview(object: Crdp.Runtime.RemoteObject): IPropCount {
        let indexedVariables = 0;
        let namedVariables = object.preview.properties.length + 1; // +1 for [[Entries]];

        return { indexedVariables, namedVariables };
    }

    private getNumPropsByEval(objectId: string, getNumPropsFn: string): Promise<IPropCount> {
        return this.chrome.Runtime.callFunctionOn({
            objectId,
            functionDeclaration: getNumPropsFn,
            silent: true,
            returnByValue: true
        }).then(response => {
            if (response.exceptionDetails) {
                const errMsg = ChromeUtils.errorMessageFromExceptionDetails(response.exceptionDetails);
                return Promise.reject<IPropCount>(errors.errorFromEvaluate(errMsg));
            } else {
                const resultProps = response.result.value;
                if (resultProps.length !== 2) {
                    return Promise.reject<IPropCount>(errors.errorFromEvaluate("Did not get expected props, got " + JSON.stringify(resultProps)));
                }

                return { indexedVariables: resultProps[0], namedVariables: resultProps[1] };
            }
        },
        error => Promise.reject<IPropCount>(errors.errorFromEvaluate(error.message)));
    }

    private fakeUrlForSourceReference(sourceReference: number): string {
        const handle = this._sourceHandles.get(sourceReference);
        return ChromeDebugAdapter.EVAL_NAME_PREFIX + handle.scriptId;
    }

    private displayNameForSourceReference(sourceReference: number): string {
        const handle = this._sourceHandles.get(sourceReference);
        return (handle && this.displayNameForScriptId(handle.scriptId)) || sourceReference + '';
    }

    private displayNameForScriptId(scriptId: number|string): string {
        return `VM${scriptId}`;
    }

    private getScriptByUrl(url: string): Crdp.Debugger.ScriptParsedEvent {
        return this._scriptsByUrl.get(url) || this._scriptsByUrl.get(utils.fixDriveLetter(url));
    }
}
