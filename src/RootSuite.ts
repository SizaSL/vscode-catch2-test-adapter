import * as vscode from 'vscode';
import { TestInfo } from 'vscode-test-adapter-api';
import { ExecutableConfig } from './ExecutableConfig';
import { Suite } from './Suite';
import { AbstractRunnable } from './AbstractRunnable';
import { AbstractTest } from './AbstractTest';
import { TestHierarchyShared } from './TestHierarchy';
import { generateId } from './Util';
import { VariableResolver } from './util/VariableResolver';
import { TestItem } from './TestItem';

export class RootSuite extends Suite implements vscode.Disposable {
  private _executables: ExecutableConfig[] = [];

  public constructor(id: string | undefined, shared: TestHierarchyShared) {
    super(shared, undefined, 'C++ TestMate', '', '', id);
  }

  public get file(): string | undefined {
    return undefined;
  }

  public get line(): number | undefined {
    return undefined;
  }

  public dispose(): void {
    this._executables.forEach(e => e.dispose());
  }

  public async load(executables: ExecutableConfig[]): Promise<Error[]> {
    this._executables.forEach(e => e.dispose());

    this._executables = executables;

    const loadResults = await Promise.all(executables.map(v => v.load(this)));
    return loadResults.reduce((acc, val) => acc.concat(val), []);
  }

  private _cancellationTokenSource = new vscode.CancellationTokenSource();
  private _runningPromise: Promise<void> = Promise.resolve();
  private _runningPromiseResolver = (_: void | PromiseLike<void>): void => {}; //eslint-disable-line

  public get isRunning(): boolean {
    return this._runningCounter > 0;
  }

  public async run(tests: TestItem[], cancellationToken: vscode.CancellationToken): Promise<void> {
    const testRunId = generateId();
    this.sendStartEventIfNeeded(testRunId, tests); // has to be first line, initilizes important variables
    const disp = cancellationToken.onCancellationRequested(() => this._cancellationTokenSource.cancel());
    try {
      const isParentIn = tests.indexOf(this) !== -1;

      let runnables = this._collectRunnables(tests, isParentIn);

      try {
        await this.runTasks('before', runnables, this._cancellationTokenSource.token);
        runnables = this._collectRunnables(tests, isParentIn); // might changed due to tasks
      } catch (e) {
        for (const [runnable, tests] of runnables) {
          runnable.sentStaticErrorEvent(testRunId, tests, e);
        }

        this.sendFinishedEventIfNeeded(testRunId);
        return this._runningPromise;
      }

      const ps: Promise<void>[] = [];

      for (const [runnable] of runnables) {
        ps.push(
          runnable
            .run(testRunId, tests, isParentIn, this._shared.taskPool, this._cancellationTokenSource.token)
            .catch(err => {
              this._shared.log.error('RootTestSuite.run.for.child', runnable.properties.path, err);
            }),
        );
      }

      try {
        await Promise.all(ps);

        try {
          await this.runTasks('after', runnables, this._cancellationTokenSource.token);
        } catch (e) {
          for (const [runnable, tests] of runnables) {
            runnable.sentStaticErrorEvent(testRunId, tests, e);
          }
        }
      } catch (e) {
        debugger;
        this._shared.log.error('everything should be handled', e);
      }

      this.sendFinishedEventIfNeeded(testRunId);

      return await this._runningPromise;
    } finally {
      disp.dispose();
    }
  }

  // public cancel(): void {
  //   if (this._cancellationTokenSource) this._cancellationTokenSource.cancel();
  // }

  public sendStartEventIfNeeded(testRunId: string, tests: TestItem[]): void {
    if (this._runningCounter++ === 0) {
      this._runningPromise = new Promise(r => (this._runningPromiseResolver = r));
      this._cancellationTokenSource = new vscode.CancellationTokenSource();
    }

    this._shared.log.debug('RootSuite start event fired', this.label, testRunId, tests);
    //TODO this._shared.sendTestRunEvent({ testRunId, type: 'started', tests });
  }

  public sendFinishedEventIfNeeded(testRunId: string): void {
    if (this._runningCounter < 1) {
      this._shared.log.error('Root Suite running counter is too low');
      this._runningCounter = 0;
      return;
    }

    this._shared.log.debug('RootSuite finished event fired', this.label, testRunId);
    this._shared.sendTestRunEvent({ testRunId, type: 'finished' });

    if (this._runningCounter === 1) {
      this._runningPromiseResolver();
      this._cancellationTokenSource?.dispose();
    }
    this._runningCounter -= 1;
  }

  public sendRunningEventIfNeeded(): void {
    // do nothing, special handling
  }

  public sendCompletedEventIfNeeded(): void {
    // do nothing, special handling
  }

  public async runTasks(
    type: 'before' | 'after',
    runnables: Map<AbstractRunnable, Readonly<AbstractTest>[]>,
    cancellationToken: vscode.CancellationToken,
  ): Promise<void> {
    const runTasks = new Set<string>();
    const runnableExecArray: string[] = [];

    for (const runnable of runnables.keys()) {
      runnable.properties.runTask[type]?.forEach(t => runTasks.add(t));
      runnableExecArray.push(runnable.properties.path);
    }

    if (runTasks.size === 0) return;

    const variableresolver = new VariableResolver(
      [
        {
          resolve: '${absPathArrayFlat}',
          rule: (): Promise<string[]> => Promise.resolve(runnableExecArray),
          isFlat: true,
        },
        { resolve: '${absPathConcatWithSpace}', rule: runnableExecArray.map(r => `"${r}"`).join(' ') },
      ],
      this._shared.variableResolver,
    );

    try {
      // sequential execution of tasks
      for (const taskName of runTasks) {
        const exitCode = await this._shared.executeTask(taskName, variableresolver, cancellationToken);

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
  }

  private _collectRunnables(tests: TestItem[], isParentIn: boolean): Map<AbstractRunnable, AbstractTest[]> {
    return this.collectTestToRun(tests, isParentIn).reduce((prev, curr) => {
      const arr = prev.get(curr.aRunnable);
      if (arr) arr.push(curr);
      else prev.set(curr.aRunnable, [curr]);
      return prev;
    }, new Map<AbstractRunnable, AbstractTest[]>());
  }

  public findTestById(idOrInfo: string | TestInfo): Readonly<AbstractTest> | undefined {
    if (typeof idOrInfo === 'string') return this.findTest(x => x.id === idOrInfo);
    else return this.findTest(x => x === idOrInfo);
  }
}
