import * as vscode from 'vscode';
import * as fs from 'fs';

import * as c2fs from './FSWrapper';
import { AbstractTestSuiteInfo } from './AbstractTestSuiteInfo';
import { Catch2TestSuiteInfo } from './framework/Catch2TestSuiteInfo';
import { GoogleTestSuiteInfo } from './framework/GoogleTestSuiteInfo';
import { DOCTestSuiteInfo } from './framework/DOCTestSuiteInfo';
import { SharedVariables } from './SharedVariables';
import { promisify } from 'util';

class GoogleTestVersion {
  private constructor(public readonly version: [number, number, number] | undefined) {}

  private static readonly _gtesthVersion: [number, [number, number, number]][] = [
    [48592, [1, 0, 0]],
    [47254, [1, 0, 1]],
    [48150, [1, 1, 0]],
    [51083, [1, 2, 0]],
    [51083, [1, 2, 1]], // !! Same as prev !! but good enough
    [54267, [1, 3, 0]],
    [74007, [1, 4, 0]],
    [77844, [1, 5, 0]],
    [82450, [1, 6, 0]],
    [88434, [1, 7, 0]],
    [85459, [1, 8, 0]],
    [89088, [1, 8, 1]],
    [93924, [1, 10, 0]],
  ];

  public static async Create(shared: SharedVariables): Promise<GoogleTestVersion> {
    try {
      const gtests = await vscode.workspace.findFiles('**/include/gtest/gtest.h', '**/node_modules/**', 2);

      if (gtests.length !== 1) {
        return new GoogleTestVersion(undefined);
      } else {
        const stats = await promisify(fs.stat)(gtests[0].fsPath);
        const fileSizeInBytes = stats['size'];
        const found = GoogleTestVersion._gtesthVersion.find(x => x[0] === fileSizeInBytes);

        if (found) return new GoogleTestVersion(found[1]);
        else return new GoogleTestVersion(undefined);
      }
    } catch (e) {
      shared.log.exception(e);
      return new GoogleTestVersion(undefined);
    }
  }
}

interface TestFrameworkInfo {
  type: 'catch2' | 'google' | 'doc';
  version: [number, number, number];
}

export class TestSuiteInfoFactory {
  public constructor(
    private readonly _shared: SharedVariables,
    private readonly _label: string,
    private readonly _description: string | undefined,
    private readonly _execPath: string,
    private readonly _execOptions: c2fs.SpawnOptions,
  ) {}

  private _googleTestVersion: GoogleTestVersion | undefined = undefined;

  public create(): Promise<AbstractTestSuiteInfo> {
    return this._shared.taskPool
      .scheduleTask(() => {
        return this._determineTestTypeOfExecutable(this._shared.execParsingTimeout);
      })
      .then((framework: TestFrameworkInfo) => {
        switch (framework.type) {
          case 'google':
            Promise.resolve()
              .then(() => {
                if (this._googleTestVersion) return this._googleTestVersion;
                else return GoogleTestVersion.Create(this._shared);
              })
              .then(gtestVersion => {
                return new GoogleTestSuiteInfo(
                  this._shared,
                  this._label,
                  this._description,
                  this._execPath,
                  this._execOptions,
                  gtestVersion.version,
                );
              });
          case 'catch2':
            return new Catch2TestSuiteInfo(
              this._shared,
              this._label,
              this._description,
              this._execPath,
              this._execOptions,
              [framework.version[0], framework.version[1], framework.version[2]],
            );
          case 'doc':
            return new DOCTestSuiteInfo(
              this._shared,
              this._label,
              this._description,
              this._execPath,
              this._execOptions,
              [framework.version[0], framework.version[1], framework.version[2]],
            );
        }
        throw Error('Unknown error:' + framework.type);
      });
  }

  private _determineTestTypeOfExecutable(execParsingTimeout: number): Promise<TestFrameworkInfo> {
    return TestSuiteInfoFactory.determineTestTypeOfExecutable(execParsingTimeout, this._execPath, this._execOptions);
  }

  public static determineTestTypeOfExecutable(
    execParsingTimeout: number,
    execPath: string,
    execOptions: c2fs.SpawnOptions,
  ): Promise<TestFrameworkInfo> {
    return c2fs.isNativeExecutableAsync(execPath).then(() => {
      return c2fs.spawnAsync(execPath, ['--help'], execOptions, execParsingTimeout).then(
        (res): TestFrameworkInfo => {
          {
            const catch2 = res.stdout.match(/Catch v([0-9]+)\.([0-9]+)\.([0-9]+)\s?/);
            if (catch2 && catch2.length == 4) {
              return { type: 'catch2', version: [Number(catch2[1]), Number(catch2[2]), Number(catch2[3])] };
            }
          }
          {
            const google = res.stdout.match(/This program contains tests written using Google Test./);
            if (google) {
              return { type: 'google', version: [0, 0, 0] };
            }
          }
          {
            const doc = res.stdout.match(/doctest version is "([0-9]+)\.([0-9]+)\.([0-9]+)"/);
            if (doc && doc.length == 4) {
              return { type: 'doc', version: [Number(doc[1]), Number(doc[2]), Number(doc[3])] };
            }
          }
          throw new Error('Not a supported test executable: ' + execPath + '\n output: ' + res);
        },
      );
    });
  }
}
