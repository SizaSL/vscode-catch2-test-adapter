import { FrameworkSpecific, RunTask } from './AdvancedExecutableInterface';
import { TestGrouping } from './TestGroupingInterface';
import { TaskPool } from './util/TaskPool';
import { Spawner, SpawnOptionsWithoutStdio } from './Spawner';
import { VariableResolver } from './util/VariableResolver';

export class RunnableProperties {
  public constructor(
    public readonly name: string | undefined,
    public readonly description: string | undefined,
    public readonly variableResolver: VariableResolver,
    public readonly path: string,
    public readonly options: SpawnOptionsWithoutStdio,
    private readonly _frameworkSpecific: FrameworkSpecific,
    _parallelizationLimit: number,
    public readonly markAsSkipped: boolean,
    public readonly runTask: RunTask,
    public readonly spawner: Spawner,
    public readonly sourceFileMap: Record<string, string>,
  ) {
    this.parallelizationPool = new TaskPool(_parallelizationLimit);
  }

  public readonly parallelizationPool: TaskPool;

  public get testGrouping(): TestGrouping | undefined {
    return this._frameworkSpecific.testGrouping;
  }

  public get prependTestRunningArgs(): string[] {
    return this._frameworkSpecific.prependTestRunningArgs ? this._frameworkSpecific.prependTestRunningArgs : [];
  }

  public get prependTestListingArgs(): string[] {
    return this._frameworkSpecific.prependTestListingArgs ? this._frameworkSpecific.prependTestListingArgs : [];
  }

  public get ignoreTestEnumerationStdErr(): boolean {
    return this._frameworkSpecific.ignoreTestEnumerationStdErr === true;
  }

  public get enableDebugColouring(): boolean {
    return this._frameworkSpecific['debug.enableOutputColouring'] === true;
  }

  public get failIfExceedsLimitNs(): number | undefined {
    return this._frameworkSpecific.failIfExceedsLimitNs;
  }
}
