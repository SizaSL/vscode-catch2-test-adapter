import * as path from 'path';
import { generateId, concat } from './Util';
import { Suite } from './Suite';
import { AbstractRunnable } from './AbstractRunnable';
import { LoggerWrapper } from './LoggerWrapper';
import * as vscode from 'vscode';
import { TestItem } from './TestItem';

export interface SharedWithTest {
  log: LoggerWrapper;
  onDidChangeTest: (item: TestItem, childrenRecursive: boolean) => void;
}

export interface StaticTestEventBase {
  state: 'errored' | 'passed' | 'failed';
  message: string;
}

//TODO some other form, TODO duration
export class TestState implements vscode.TestState {
  public constructor(
    public state: vscode.TestRunState,
    public messages?: Array<vscode.TestMessage>,
    public duration?: number,
  ) {}
}

export abstract class AbstractTest implements vscode.TestItem {
  public readonly type: 'test' = 'test'; // TODO we might can get rid of this
  public readonly id: string;
  public readonly testNameAsId: string;
  public readonly debuggable = true;

  protected _label = '';
  protected _additionalDesciption = '';
  protected _additionalTooltip = '';
  protected _skipped = false;
  protected _tags: string[] = [];
  protected _testDescription: string | undefined = undefined;
  protected _typeParam: string | undefined = undefined; // gtest specific
  protected _valueParam: string | undefined = undefined; // gtest specific
  protected _file: string | undefined = undefined;
  protected _line: number | undefined = undefined;
  protected _staticEvent: StaticTestEventBase | undefined;

  public lastRunMilisec: number | undefined;

  protected constructor(
    protected readonly _shared: SharedWithTest,
    public readonly aRunnable: AbstractRunnable,
    public readonly parent: Suite, // ascending
    testNameAsId: string,
    label: string,
    file: string | undefined,
    line: number | undefined,
    skipped: boolean,
    staticEvent: StaticTestEventBase | undefined,
    pureTags: string[], // without brackets
    testDescription: string | undefined,
    typeParam: string | undefined, // gtest specific
    valueParam: string | undefined, // gtest specific
  ) {
    this.id = generateId();
    this.testNameAsId = testNameAsId;

    this._updateBase(label, file, line, skipped, pureTags, testDescription, typeParam, valueParam, staticEvent);

    this.state = new TestState(skipped ? vscode.TestRunState.Skipped : vscode.TestRunState.Unset);
  }

  public state: vscode.TestState;

  protected _updateBase(
    label: string,
    file: string | undefined,
    line: number | undefined,
    skipped: boolean,
    tags: string[], // without brackets
    testDescription: string | undefined,
    typeParam: string | undefined, // gtest specific
    valueParam: string | undefined, // gtest specific
    staticEvent: StaticTestEventBase | undefined,
  ): boolean {
    if (line && line < 0) throw Error('line smaller than zero');

    let changed = false;

    if (this._label != label) {
      changed = true;
      this._label = label;
    }

    const newFile = file ? path.normalize(file) : undefined;
    if (this._file != newFile) {
      changed = true;
      this._file = newFile;
    }

    if (this._line != line) {
      changed = true;
      this._line = line;
    }

    if (this._skipped != skipped) {
      changed = true;
      this._skipped = skipped;
    }

    if (this._testDescription != testDescription) {
      changed = true;
      this._testDescription = testDescription;
    }

    if (tags.length !== this._tags.length || tags.some(t => this._tags.indexOf(t) === -1)) {
      changed = true;
      this._tags = tags;
    }

    if (this._typeParam != typeParam) {
      changed = true;
      this._typeParam = typeParam;
    }

    if (this._valueParam != valueParam) {
      changed = true;
      this._valueParam = valueParam;
    }

    if (this._staticEvent !== staticEvent) {
      changed = true;
      this._staticEvent = staticEvent;
    }

    return changed;
  }

  public abstract compare(testNameAsId: string): boolean;

  // should be used only from TestEventBuilder
  public _updateDescriptionAndTooltip(description: string, tooltip: string): void {
    this._additionalDesciption = description;
    this._additionalTooltip = tooltip;
  }

  public get label(): string {
    return this._label;
  }

  public get description(): string {
    const description: string[] = [];

    if (this._tags.length > 0) description.push(this._tags.map(t => `[${t}]`).join(''));

    if (this._typeParam) description.push(`#️⃣Type: ${this._typeParam}`);

    if (this._valueParam) description.push(`#️⃣Value: ${this._valueParam}`);

    return concat(description.join('\n'), this._additionalDesciption, ' ');
  }

  public get tooltip(): string {
    const tooltip = [`Name: ${this.testNameAsId}`];

    if (this._tags.length > 0) {
      const tagsStr = this._tags.map(t => `[${t}]`).join('');
      tooltip.push(`Tags: ${tagsStr}`);
    }

    if (this._testDescription) tooltip.push(`Description: ${this._testDescription}`);

    if (this._typeParam) tooltip.push(`#️⃣TypeParam() = ${this._typeParam}`);

    if (this._valueParam) tooltip.push(`#️⃣GetParam() = ${this._valueParam}`);

    return concat(tooltip.join('\n'), this._additionalTooltip, '\n');
  }

  public get file(): string | undefined {
    return this._file;
  }

  public get line(): number | undefined {
    return this._line;
  }

  public get skipped(): boolean {
    return this._skipped || this.aRunnable.properties.markAsSkipped;
  }

  public get errored(): boolean {
    return this._staticEvent !== undefined && this._staticEvent!.state === 'errored';
  }

  public get message(): string | undefined {
    return this._staticEvent?.message;
  }

  //TODO remove this
  public getStaticEvent(): boolean {
    if (this._staticEvent) {
      this.state = new TestState(vscode.TestRunState.Errored, [{ message: this._staticEvent?.message || '' }]);
      this._shared.onDidChangeTest(this, false);
      return true;
    } else {
      return false;
    }
  }

  public *route(): IterableIterator<Suite> {
    let parent: Suite | undefined = this.parent;
    do {
      yield parent;
      parent = parent.parent;
    } while (parent);
  }

  private _reverseRoute: Suite[] | undefined = undefined;

  public reverseRoute(): Suite[] {
    if (this._reverseRoute === undefined) this._reverseRoute = [...this.route()].reverse();
    return this._reverseRoute;
  }

  public removeWithLeafAscendants(): void {
    const index = this.parent.children.indexOf(this);
    if (index == -1) {
      this._shared.log.info(
        'Removing an already removed one.',
        'Probably it was deleted and recompiled but there was no fs-change event and no reload has happened',
        this,
      );
      return;
    } else {
      this.parent.children.splice(index, 1);

      this.parent.removeIfLeaf();
    }
  }

  public getStartEvent(): void {
    this.state = new TestState(vscode.TestRunState.Running);
    this._shared.onDidChangeTest(this, false);
  }

  public getSkippedEvent(): void {
    this.state = new TestState(vscode.TestRunState.Skipped);
    this._shared.onDidChangeTest(this, false);
  }

  public abstract parseAndProcessTestCase(
    output: string,
    rngSeed: number | undefined,
    timeout: number | null,
    stderr: string | undefined,
  ): void;

  public getCancelledEvent(testOutput: string): void {
    const message = '⏹ Run is stopped by user. ✋' + '\n\nTest Output : R"""' + testOutput + '"""';
    this.state = new TestState(vscode.TestRunState.Unset, [{ message }]);
    this._shared.onDidChangeTest(this, false);
  }

  public getTimeoutEvent(milisec: number): void {
    const message = '⌛️ Timed out: "testMate.cpp.test.runtimeLimit": ' + milisec / 1000 + ' second(s).';
    this.state = new TestState(vscode.TestRunState.Errored, [{ message }]);
    this._shared.onDidChangeTest(this, false);
  }

  //TODO remove this
  public getFailedEventBase(testRunState: vscode.TestRunState, message: string): void {
    this.state = new TestState(testRunState, [{ message }]);
    this._shared.onDidChangeTest(this, false);
  }

  public enumerateTestInfos(fn: (v: AbstractTest) => void): void {
    fn(this);
  }

  public findTest(pred: (v: AbstractTest) => boolean): Readonly<AbstractTest> | undefined {
    return pred(this) ? this : undefined;
  }

  public collectTestToRun(
    tests: readonly TestItem[],
    isParentIn: boolean,
    filter: (test: AbstractTest) => boolean = (): boolean => true,
  ): AbstractTest[] {
    if ((isParentIn && !this.skipped) || tests.indexOf(this) !== -1) {
      if (filter(this)) return [this];
      else return [];
    } else {
      return [];
    }
  }
}
