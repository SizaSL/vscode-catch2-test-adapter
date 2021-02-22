import * as pathlib from 'path';
import * as fs from 'fs';

import { RunnableProperties } from './RunnableProperties';
import { AbstractTest } from './AbstractTest';
import { Suite } from './Suite';
import { TaskPool } from './util/TaskPool';
import { TestHierarchyShared } from './TestHierarchy';
import { RunningRunnable } from './RunningRunnable';
import { promisify, inspect } from 'util';
import { Version, reverse, getAbsolutePath, CancellationToken, CancellationFlag } from './Util';
import {
  resolveOSEnvironmentVariables,
  createPythonIndexerForPathVariable,
  ResolveRuleAsync,
  resolveVariablesAsync,
} from './util/ResolveRule';
import { TestGrouping, GroupByExecutable, GroupByTagRegex, GroupByRegex } from './TestGroupingInterface';
import { TestEvent } from 'vscode-test-adapter-api';
import { RootSuite } from './RootSuite';
import { EOL } from 'os';
import { isSpawnBusyError } from './util/FSWrapper';
import { TestItem } from './TestItem';

export class RunnableReloadResult {
  public tests = new Set<AbstractTest>();
  public changedAny = false;

  public add(test: AbstractTest, changed: boolean): this {
    this.tests.add(test);
    this.changedAny = this.changedAny || changed;
    return this;
  }
}

export abstract class AbstractRunnable {
  public constructor(
    protected readonly _shared: TestHierarchyShared,
    protected readonly _rootSuite: RootSuite,
    public readonly properties: RunnableProperties,
    public readonly frameworkName: string,
    public readonly frameworkVersion: Promise<Version | undefined>,
  ) {
    frameworkVersion
      .then(version => {
        if (AbstractRunnable._reportedFrameworks.findIndex(x => x === frameworkName) === -1) {
          const versionStr = version ? version.toString() : 'unknown';

          const tags: Record<string, string> = {};
          tags[this.frameworkName] = `${this.frameworkName}@${versionStr}`;
          _shared.log.setTags(tags);

          AbstractRunnable._reportedFrameworks.push(frameworkName);
        }
      })
      .catch(e => this._shared.log.exceptionS(e));
  }

  private static _reportedFrameworks: string[] = [];

  protected _getGroupByExecutable(): GroupByExecutable {
    return {
      label: this.properties.name,
      description: this.properties.description,
    };
  }

  private _lastReloadTime: number | undefined = undefined;

  public get lastReloadTime(): number | undefined {
    return this._lastReloadTime;
  }

  private _tests = new Set<AbstractTest>();

  public get tests(): Set<AbstractTest> {
    return this._tests;
  }

  private _getOrCreateChildSuite(label: string, description: string, tooltip: string, group: Suite): Suite {
    const cond = (v: Suite | AbstractTest): boolean => v.type === 'suite' && v.compare(label, description);
    const found = group.children.find(cond) as Suite | undefined;
    if (found) {
      return found;
    } else {
      const newG = group.addSuite(new Suite(this._shared, group, label, description, tooltip, undefined));
      return newG;
    }
  }

  private async _resolveAndGetOrCreateChildSuite(
    parentGroup: Suite,
    label: string,
    description: string | undefined,
    tooltip: string | undefined,
    varsToResolve: ResolveRuleAsync<string>[],
  ): Promise<Suite> {
    const resolvedLabel = await this._resolveText(label, ...varsToResolve);
    const resolvedDescr = description !== undefined ? await this._resolveText(description, ...varsToResolve) : '';
    const resolvedToolt = tooltip !== undefined ? await this._resolveText(tooltip, ...varsToResolve) : '';

    return this._getOrCreateChildSuite(resolvedLabel, resolvedDescr, resolvedToolt, parentGroup);
  }

  private _updateVarsWithTags(tg: TestGrouping, tags: string[], tagsResolveRule: ResolveRuleAsync<string>): void {
    const tagVar = '${tag}';

    tagsResolveRule.rule = async (): Promise<string> => {
      let tagFormat = `[${tagVar}]`;
      if (tg.tagFormat !== undefined) {
        if (tg.tagFormat.indexOf(tagVar) === -1) {
          this._shared.log.warn(`tagFormat should contain "${tagVar}" substring`, tg.tagFormat);
        } else {
          tagFormat = tg.tagFormat;
        }
      }
      return tags.map(t => tagFormat.replace(tagVar, t)).join('');
    };
  }

  private static readonly _variableRe = /\$\{[^ ]*\}/;

  private async _resolveText(text: string, ...additionalVarToValue: readonly ResolveRuleAsync[]): Promise<string> {
    let resolvedText = text;
    try {
      resolvedText = await this.properties.variableResolver.resolveAsync(resolvedText);

      resolvedText =
        additionalVarToValue.length > 0
          ? await resolveVariablesAsync(resolvedText, additionalVarToValue)
          : resolvedText;

      resolvedText = resolveOSEnvironmentVariables(resolvedText, false);

      if (resolvedText.match(AbstractRunnable._variableRe))
        this._shared.log.warn('Possibly unresolved variable', resolvedText, text, this);
    } catch (e) {
      this._shared.log.error('resolveText', text, e, this);
    }
    return resolvedText;
  }

  private static readonly _tagVar = '${tags}';

  protected async _createSubtreeAndAddTest(
    testGrouping: TestGrouping,
    testNameAsId: string,
    testName: string,
    file: string | undefined,
    tags: string[], // in case of google test it is the TestCase
    createTest: (parent: Suite) => AbstractTest,
    updateTest: (old: AbstractTest) => boolean,
  ): Promise<[AbstractTest, boolean]> {
    this._shared.log.info('testGrouping', testNameAsId);
    this._shared.log.debug('testGrouping', { testName, testNameAsId, file, tags, testGrouping });

    tags.sort();

    const tagsResolveRule: ResolveRuleAsync<string> = {
      resolve: AbstractRunnable._tagVar,
      rule: '', // will be filled soon enough
    };
    const sourceRelPath = file ? pathlib.relative(this._shared.workspace.uri.fsPath, file) : '';

    const varsToResolve = [
      tagsResolveRule,
      createPythonIndexerForPathVariable('sourceRelPath', sourceRelPath),
      createPythonIndexerForPathVariable('sourceAbsPath', file ? file : ''),
    ];

    let group = this._rootSuite as Suite;
    let currentGrouping: TestGrouping = testGrouping;

    try {
      while (true) {
        if (currentGrouping.groupByExecutable) {
          const g = currentGrouping.groupByExecutable;
          this._updateVarsWithTags(g, tags, tagsResolveRule);

          const label = g.label !== undefined ? g.label : '${filename}';
          const description = g.description !== undefined ? g.description : '${relDirpath}${osPathSep}';

          group = await this._resolveAndGetOrCreateChildSuite(
            group,
            label,
            description,
            `Path: ${this.properties.path}\nCwd: ${this.properties.options.cwd}`,
            varsToResolve,
          );

          currentGrouping = g;
        } else if (currentGrouping.groupBySource) {
          const g = currentGrouping.groupBySource;
          this._updateVarsWithTags(g, tags, tagsResolveRule);

          if (file) {
            const label = g.label ? g.label : sourceRelPath;
            const description = g.description;

            group = await this._resolveAndGetOrCreateChildSuite(group, label, description, undefined, varsToResolve);
          } else if (g.groupUngroupedTo) {
            group = await this._resolveAndGetOrCreateChildSuite(
              group,
              g.groupUngroupedTo,
              undefined,
              undefined,
              varsToResolve,
            );
          }

          currentGrouping = g;
        } else if (currentGrouping.groupByTags) {
          const g = currentGrouping.groupByTags;
          this._updateVarsWithTags(g, tags, tagsResolveRule);

          if (
            g.tags === undefined ||
            (Array.isArray(g.tags) &&
              g.tags.every(v => typeof Array.isArray(v) && v.every(vv => typeof vv === 'string')))
          ) {
            if (g.tags === undefined || g.tags.length === 0 || g.tags.every(t => t.length == 0)) {
              if (tags.length > 0) {
                group = await this._resolveAndGetOrCreateChildSuite(
                  group,
                  g.label ? g.label : AbstractRunnable._tagVar,
                  g.description,
                  undefined,
                  varsToResolve,
                );
              } else if (g.groupUngroupedTo) {
                group = await this._resolveAndGetOrCreateChildSuite(
                  group,
                  g.groupUngroupedTo,
                  undefined,
                  undefined,
                  varsToResolve,
                );
              }
            } else {
              const combos = g.tags.filter(arr => arr.length > 0);
              const foundCombo = combos.find(combo => combo.every(t => tags.indexOf(t) !== -1));

              if (foundCombo) {
                this._updateVarsWithTags(g, foundCombo, tagsResolveRule);
                group = await this._resolveAndGetOrCreateChildSuite(
                  group,
                  g.label ? g.label : AbstractRunnable._tagVar,
                  g.description,
                  undefined,
                  varsToResolve,
                );
              } else if (g.groupUngroupedTo) {
                group = await this._resolveAndGetOrCreateChildSuite(
                  group,
                  g.groupUngroupedTo,
                  undefined,
                  undefined,
                  varsToResolve,
                );
              }
            }
          } else {
            this._shared.log.warn('groupByTags.tags should be an array of strings. Empty array is OK.', g.tags);
          }

          currentGrouping = g;
        } else if (currentGrouping.groupByTagRegex || currentGrouping.groupByRegex) {
          const groupType = currentGrouping.groupByTagRegex ? 'groupByTagRegex' : 'groupByRegex';
          const g: GroupByTagRegex | GroupByRegex = currentGrouping.groupByTagRegex
            ? currentGrouping.groupByTagRegex
            : currentGrouping.groupByRegex!;

          this._updateVarsWithTags(g, tags, tagsResolveRule);

          if (g.regexes) {
            if (Array.isArray(g.regexes) && g.regexes.length > 0 && g.regexes.every(v => typeof v === 'string')) {
              let match: RegExpMatchArray | null = null;

              const matchOn = groupType == 'groupByTagRegex' ? tags : [testName];

              let reIndex = 0;
              while (reIndex < g.regexes.length && match == null) {
                let tagIndex = 0;
                while (tagIndex < matchOn.length && match == null) {
                  match = matchOn[tagIndex++].match(g.regexes[reIndex]);
                }
                reIndex++;
              }

              if (match !== null) {
                this._shared.log.info(groupType + ' matched on', testName, g.regexes[reIndex - 1]);
                const matchGroup = match[1] ? match[1] : match[0];

                const lowerMatchGroup = matchGroup.toLowerCase();

                const matchVar: ResolveRuleAsync[] = [
                  { resolve: '${match}', rule: matchGroup },
                  { resolve: '${match_lowercased}', rule: lowerMatchGroup },
                  {
                    resolve: '${match_upperfirst}',
                    rule: async (): Promise<string> =>
                      lowerMatchGroup.substr(0, 1).toUpperCase() + lowerMatchGroup.substr(1),
                  },
                ];

                const label = g.label ? await resolveVariablesAsync(g.label, matchVar) : matchGroup;
                const description =
                  g.description !== undefined ? await resolveVariablesAsync(g.description, matchVar) : undefined;

                group = await this._resolveAndGetOrCreateChildSuite(
                  group,
                  label,
                  description,
                  undefined,
                  varsToResolve,
                );
              } else if (g.groupUngroupedTo) {
                group = await this._resolveAndGetOrCreateChildSuite(
                  group,
                  g.groupUngroupedTo,
                  undefined,
                  undefined,
                  varsToResolve,
                );
              }
            } else {
              this._shared.log.warn(groupType + '.regexes should be a non-empty array of strings.', g.regexes);
            }
          } else {
            this._shared.log.warn(groupType + ' missing "regexes": skipping grouping level');
          }
          currentGrouping = g;
        } else {
          break;
        }
      }
    } catch (e) {
      this._shared.log.exceptionS(e);
    }

    const old = group.children.find(t => t instanceof AbstractTest && t.compare(testNameAsId)) as
      | AbstractTest
      | undefined;

    if (old) {
      return [old, updateTest(old)];
    } else {
      const test = group.addTest(createTest(group));
      this._tests.add(test);
      return [test, true];
    }
  }

  public removeTests(): void {
    this._tests.forEach(t => t.removeWithLeafAscendants());
    this._tests = new Set();
  }

  protected _createError(title: string, message: string): (parent: Suite) => AbstractTest {
    return (parent: Suite): AbstractTest => {
      const shared = this._shared;
      const runnable = this as AbstractRunnable;
      const test = new (class extends AbstractTest {
        public constructor() {
          super(
            shared,
            runnable,
            parent,
            title,
            title,
            undefined,
            undefined,
            true,
            {
              state: 'errored',
              message,
            },
            [],
            '⚡️ Run me for details ⚡️',
            undefined,
            undefined,
          );
        }

        public compare(testNameAsId: string): boolean {
          return testNameAsId === testNameAsId;
        }

        public getDebugParams(): string[] {
          throw Error('assert');
        }

        public parseAndProcessTestCase(): void {
          throw Error('assert');
        }
      })();

      return test;
    };
  }

  protected async _createAndAddError(label: string, message: string): Promise<RunnableReloadResult> {
    return new RunnableReloadResult().add(
      ...(await this._createSubtreeAndAddTest(
        { groupByExecutable: this._getGroupByExecutable() },
        label,
        label,
        undefined,
        [],
        this._createError(label, message),
        () => false,
      )),
    );
  }

  protected _createAndAddUnexpectedStdError(stdout: string, stderr: string): Promise<RunnableReloadResult> {
    return this._createAndAddError(
      `⚡️ Unexpected ERROR while parsing`,
      [
        `❗️Unexpected stderr!`,
        `(One might can use ignoreTestEnumerationStdErr as the LAST RESORT. Check README for details.)`,
        `spawn`,
        `stout:`,
        `${stdout}`,
        `stderr:`,
        `${stderr}`,
      ].join(EOL),
    );
  }

  private _getModiTime(): Promise<number | undefined> {
    return promisify(fs.stat)(this.properties.path).then(
      stat => stat.mtimeMs,
      () => undefined,
    );
  }

  private _splitTestSetForMultirunIfEnabled(tests: readonly AbstractTest[]): (readonly AbstractTest[])[] {
    const parallelizationLimit = this.properties.parallelizationPool.maxTaskCount;

    if (parallelizationLimit > 1) {
      // user intention?
      const testPerTask = Math.max(1, Math.round(this.tests.size / parallelizationLimit));

      const targetTaskCount = Math.min(tests.length, Math.max(1, Math.round(tests.length / testPerTask)));

      const buckets: AbstractTest[][] = [];

      for (let i = 0; i < targetTaskCount; ++i) {
        buckets.push([]);
      }

      for (let i = 0; i < tests.length; ++i) {
        buckets[i % buckets.length].push(tests[i]);
      }

      if (buckets.length > 1) {
        this._shared.log.info(
          "Parallel execution of the same executable is enabled. Note: This can cause problems if the executable's test cases depend on the same resource.",
          buckets.length,
        );
      }

      return buckets;
    } else {
      return [tests];
    }
  }

  private _splitTestsToSmallEnoughSubsets(tests: readonly AbstractTest[]): AbstractTest[][] {
    let lastSet: AbstractTest[] = [];
    const subsets: AbstractTest[][] = [lastSet];
    let charCount = 0;
    const limit = 30000;

    for (const test of tests) {
      if (charCount + test.testNameAsId.length >= limit) {
        lastSet = [];
        subsets.push(lastSet);
      }
      lastSet.push(test);
      charCount += test.testNameAsId.length;
    }

    return subsets;
  }

  protected abstract _reloadChildren(cancellationFlag: CancellationFlag): Promise<RunnableReloadResult>;

  protected abstract _getRunParamsInner(childrenToRun: readonly Readonly<AbstractTest>[]): string[];

  private _getRunParams(childrenToRun: readonly Readonly<AbstractTest>[]): string[] {
    return this.properties.prependTestRunningArgs.concat(this._getRunParamsInner(childrenToRun));
  }

  protected abstract _handleProcess(testRunId: string, runInfo: RunningRunnable): Promise<void>;

  protected abstract _getDebugParamsInner(
    childrenToRun: readonly Readonly<AbstractTest>[],
    breakOnFailure: boolean,
  ): string[];

  public getDebugParams(childrenToRun: readonly Readonly<AbstractTest>[], breakOnFailure: boolean): string[] {
    return this.properties.prependTestRunningArgs.concat(this._getDebugParamsInner(childrenToRun, breakOnFailure));
  }

  public reloadTests(taskPool: TaskPool, cancellationFlag: CancellationFlag): Promise<void> {
    if (cancellationFlag.isCancellationRequested) return Promise.resolve();

    return taskPool.scheduleTask(async () => {
      this._shared.log.info('reloadTests', this.frameworkName, this.frameworkVersion, this.properties.path);

      const lastModiTime = await this._getModiTime();

      if (this._lastReloadTime === undefined || lastModiTime === undefined || this._lastReloadTime !== lastModiTime) {
        this._lastReloadTime = lastModiTime;

        const reloadResult = await this._reloadChildren(cancellationFlag);

        const toRemove: AbstractTest[] = [];
        for (const t of this._tests) if (!reloadResult.tests.has(t)) toRemove.push(t);

        if (toRemove.length > 0 || reloadResult.changedAny) {
          toRemove.forEach(t => {
            t.removeWithLeafAscendants();
            this._tests.delete(t);
          });
        }
      } else {
        this._shared.log.debug('reloadTests was skipped due to mtime', this.properties.path);
      }
    });
  }

  public async run(
    testRunId: string,
    tests: readonly TestItem[],
    isParentIn: boolean,
    taskPool: TaskPool,
    cancellationToken: CancellationToken,
  ): Promise<void> {
    const collectChildrenToRun = (): readonly AbstractTest[] =>
      this._rootSuite.collectTestToRun(tests, isParentIn, (test: AbstractTest): boolean => test.aRunnable === this);

    try {
      await this.runTasks('beforeEach', taskPool, cancellationToken);
    } catch (e) {
      this.sentStaticErrorEvent(testRunId, collectChildrenToRun(), e);

      return;
    }

    await this.reloadTests(taskPool, cancellationToken); // this might relod the test list if the file timestamp has changed

    const childrenToRun = collectChildrenToRun();

    if (childrenToRun.length === 0) return;

    const buckets = this._splitTestSetForMultirunIfEnabled(childrenToRun);

    await Promise.all(
      buckets.map(async (bucket: readonly AbstractTest[]) => {
        const smallerTestSet = this._splitTestsToSmallEnoughSubsets(bucket);
        for (const testSet of smallerTestSet) await this._runInner(testRunId, testSet, taskPool, cancellationToken);
      }),
    );

    try {
      await this.runTasks('afterEach', taskPool, cancellationToken);
    } catch (e) {
      this.sentStaticErrorEvent(testRunId, collectChildrenToRun(), e);
    }
  }

  private _runInner(
    testRunId: string,
    childrenToRun: readonly AbstractTest[],
    taskPool: TaskPool,
    cancellationToken: CancellationToken,
  ): Promise<void> {
    return this.properties.parallelizationPool.scheduleTask(() => {
      const runnableDescendant: AbstractTest[] = [];

      childrenToRun.forEach(t => {
        t.getStaticEvent();
        if (!t.getStaticEvent()) runnableDescendant.push(t);
      });

      if (runnableDescendant.length === 0) {
        return Promise.resolve();
      }

      const runIfNotCancelled = (): Promise<void> => {
        if (cancellationToken.isCancellationRequested) {
          this._shared.log.info('test was canceled:', this);
          return Promise.resolve();
        }
        return this._runProcess(testRunId, runnableDescendant, cancellationToken);
      };

      return taskPool.scheduleTask(runIfNotCancelled).catch((err: Error) => {
        if (isSpawnBusyError(err)) {
          this._shared.log.info('executable is busy, rescheduled: 2sec', err);

          return promisify(setTimeout)(2000).then(() => {
            taskPool.scheduleTask(runIfNotCancelled);
          });
        } else {
          throw err;
        }
      });
    });
  }

  private async _runProcess(
    testRunId: string,
    childrenToRun: readonly AbstractTest[],
    cancellationToken: CancellationToken,
  ): Promise<void> {
    const execParams = this._getRunParams(childrenToRun);

    this._shared.log.info('proc starting', this.properties.path, execParams);

    const runInfo = new RunningRunnable(
      await this.properties.spawner.spawn(this.properties.path, execParams, this.properties.options),
      childrenToRun,
      cancellationToken,
    );

    this._shared.log.info('proc started', runInfo.process.pid, this.properties.path, this.properties, execParams);

    runInfo.setPriorityAsync(this._shared.log);

    runInfo.process.on('error', (err: Error) => {
      this._shared.log.error('process error event:', err, this);
    });

    {
      let trigger: (cause: 'reschedule' | 'closed' | 'timeout') => void;

      const changeConn = this._shared.configuration.onDidChangeExecRunningTimeout(() => {
        trigger('reschedule');
      });

      runInfo.process.once('close', (...args) => {
        this._shared.log.info('proc close:', this.properties.path, args);
        trigger('closed');
      });

      const shedule = (): Promise<void> => {
        return new Promise<'reschedule' | 'closed' | 'timeout'>(resolve => {
          trigger = resolve;
          const execRunningTimeout = this._shared.configuration.getExecRunningTimeout();

          if (execRunningTimeout !== null) {
            const elapsed = Date.now() - runInfo.startTime;
            const left = Math.max(0, execRunningTimeout - elapsed);
            setTimeout(resolve, left, 'timeout');
          }
        }).then(cause => {
          if (cause === 'closed') {
            return Promise.resolve();
          } else if (cause === 'timeout') {
            runInfo.killProcess(this._shared.configuration.getExecRunningTimeout());
            return Promise.resolve();
          } else if (cause === 'reschedule') {
            return shedule();
          } else {
            throw new Error('unknown case: ' + cause);
          }
        });
      };

      shedule().finally(() => {
        changeConn.dispose();
      });
    }

    return this._handleProcess(testRunId, runInfo)
      .catch((reason: Error) => this._shared.log.exceptionS(reason))
      .finally(() => this._shared.log.info('proc finished:', this.properties.path));
  }

  public async runTasks(
    type: 'beforeEach' | 'afterEach',
    taskPool: TaskPool,
    cancellationToken: CancellationToken,
  ): Promise<void> {
    if (this.properties.runTask[type]?.length) {
      return taskPool.scheduleTask(async () => {
        try {
          // sequential execution of tasks
          for (const taskName of this.properties.runTask[type] || []) {
            const exitCode = await this._shared.executeTask(
              taskName,
              this.properties.variableResolver,
              cancellationToken,
            );

            if (exitCode !== undefined) {
              if (exitCode !== 0) {
                throw Error(
                  `Task "${taskName}" has returned with exitCode(${exitCode}) != 0. (\`testMate.test.advancedExecutables:runTask.${type}\`)`,
                );
              }
            }
          }
        } catch (e) {
          throw Error(
            `One of the tasks of the \`testMate.test.advancedExecutables:runTask.${type}\` array has failed: ` + e,
          );
        }
      });
    }
  }

  protected _findTest(pred: (t: AbstractTest) => boolean): AbstractTest | undefined {
    for (const t of this._tests) if (pred(t)) return t;
    return undefined;
  }

  protected async _resolveSourceFilePath(file: string | undefined): Promise<string | undefined> {
    if (typeof file != 'string') return undefined;

    let resolved = file;

    for (const m in this.properties.sourceFileMap) {
      resolved = resolved.replace(m, this.properties.sourceFileMap[m]); // Note: it just replaces the first occurence
    }

    resolved = await this._resolveText(resolved);
    resolved = this._findFilePath(resolved);

    this._shared.log.debug('_resolveSourceFilePath:', file, '=>', resolved);

    return resolved;
  }

  protected _findFilePath(matchedPath: string): string {
    if (pathlib.isAbsolute(matchedPath)) return matchedPath;

    const directoriesToCheck: string[] = [pathlib.dirname(this.properties.path)];

    if (this.properties.options.cwd && !this.properties.path.startsWith(this.properties.options.cwd))
      directoriesToCheck.push(this.properties.options.cwd);

    if (
      !this.properties.path.startsWith(this._shared.workspace.uri.fsPath) &&
      (!this.properties.options.cwd || !this.properties.options.cwd.startsWith(this._shared.workspace.uri.fsPath))
    )
      directoriesToCheck.push(this._shared.workspace.uri.fsPath);

    const found = getAbsolutePath(matchedPath, directoriesToCheck);

    return found || matchedPath;
  }

  public sendMinimalEventsIfNeeded(testRunId: string, completed: Suite[], running: Suite[]): void {
    if (completed.length === 0) {
      reverse(running)(v => v.sendRunningEventIfNeeded(testRunId));
    } else if (running.length === 0) {
      completed.forEach(v => v.sendCompletedEventIfNeeded(testRunId));
    } else if (completed[0] === running[0]) {
      if (completed.length !== running.length) this._shared.log.error('completed.length !== running.length');
    } else {
      let completedIndex = -1;
      let runningIndex = -1;

      do {
        ++completedIndex;
        runningIndex = running.indexOf(completed[completedIndex]);
      } while (completedIndex < completed.length && runningIndex === -1);

      for (let i = 0; i < completedIndex; ++i) completed[i].sendCompletedEventIfNeeded(testRunId);
      for (let i = runningIndex - 1; i >= 0; --i) running[i].sendRunningEventIfNeeded(testRunId);
    }
  }

  public sendStaticEvents(
    testRunId: string,
    childrenToRun: readonly AbstractTest[],
    staticEvent: TestEvent | undefined, //TODO: error reporting is not crrect here
  ): void {
    childrenToRun.forEach(test => {
      test.getStaticEvent();
    });
  }

  // eslint-disable-next-line
  public sentStaticErrorEvent(testRunId: string, childrenToRun: readonly AbstractTest[], err: any): void {
    this.sendStaticEvents(testRunId, childrenToRun, {
      type: 'test',
      test: 'will be filled automatically',
      state: 'errored',
      message: err instanceof Error ? `⚡️ ${err.name}: ${err.message}` : inspect(err),
    });
  }
}
