import { LogOutputChannel } from "vscode";
import { Stack } from "../types";
import { Repository } from "../typings/git";
import * as cp from "child_process";
import { EOL } from "os";

export interface IStackApi {
  getStacks(): Promise<Stack[]>;
  getBranchesByCommitterDate(): Promise<string[]>;

  newStack(
    name: string,
    sourceBranch: string,
    branchName?: string
  ): Promise<void>;

  newBranch(stack: string, name: string): Promise<void>;
  addBranch(stack: string, name: string): Promise<void>;
  removeBranch(stack: string, name: string): Promise<void>;

  sync(stack: string): Promise<void>;
  pull(stack: string): Promise<void>;
  push(stack: string, forceWithLease: boolean): Promise<void>;

  update(stack: string): Promise<void>;
  delete(stack: string): Promise<void>;
  cleanup(stack: string): Promise<void>;

  switchToBranch(branch: string): Promise<void>;
}

export class StackApi implements IStackApi {
  constructor(
    private readonly _repository: Repository,
    private readonly _logger: LogOutputChannel
  ) {}

  private workingDirectory(): string {
    return this._repository.rootUri.fsPath;
  }

  async getStacks(): Promise<Stack[]> {
    const stacks = await this.execJson<Stack[]>(
      `stack status --all --json --working-dir "${this.workingDirectory()}"`,
      false
    );

    return stacks;
  }

  async getBranchesByCommitterDate(): Promise<string[]> {
    const branches = await this._repository.getBranches({});
    return branches
      .filter((branch) => branch.name)
      .map((branch) => branch.name!);
  }

  async newStack(
    name: string,
    sourceBranch: string,
    branchName?: string
  ): Promise<void> {
    let cmd = `stack new --name "${name}" --source-branch "${sourceBranch}" --working-dir "${this.workingDirectory()}"`;

    if (branchName) {
      cmd += ` --branch ${branchName}`;
    }

    this.exec(cmd);
  }

  async newBranch(stack: string, name: string): Promise<void> {
    let cmd = `stack branch new --stack "${stack}" --name "${name}" --working-dir "${this.workingDirectory()}"`;
    await this.exec(cmd);
  }

  async addBranch(stack: string, name: string): Promise<void> {
    let cmd = `stack branch add --stack "${stack}" --name "${name}" --working-dir "${this.workingDirectory()}"`;
    await this.exec(cmd);
  }

  async removeBranch(stack: string, name: string): Promise<void> {
    let cmd = `stack branch remove --stack "${stack}" --name "${name}" --working-dir "${this.workingDirectory()}" --yes`;
    await this.exec(cmd);
  }

  async sync(stack: string): Promise<void> {
    await this.exec(
      `stack sync --stack "${stack}" --working-dir "${this.workingDirectory()}" --yes --verbose`
    );
  }

  async pull(stack: string): Promise<void> {
    await this.exec(
      `stack pull --stack "${stack}" --working-dir "${this.workingDirectory()}"`
    );
  }

  async push(stack: string, forceWithLease: boolean): Promise<void> {
    await this.exec(
      `stack push --stack "${stack}" --working-dir "${this.workingDirectory()}" ${
        forceWithLease ? "--force-with-lease" : ""
      }`
    );
  }

  async update(stack: string): Promise<void> {
    await this.exec(
      `stack update --stack "${stack}" --working-dir "${this.workingDirectory()}"`
    );
  }

  async delete(stack: string): Promise<void> {
    await this.exec(
      `stack delete --stack "${stack}" --working-dir "${this.workingDirectory()}" --yes`
    );
  }

  async cleanup(stack: string): Promise<void> {
    await this.exec(
      `stack cleanup --stack "${stack}" --working-dir "${this.workingDirectory()}" --yes`
    );
  }

  async switchToBranch(branch: string): Promise<void> {
    await this.exec(
      `stack switch --branch "${branch}" --working-dir "${this.workingDirectory()}"`
    );
  }

  private exec(
    cmd: string,
    log: boolean = true,
    cwd?: string
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this._logger.info(cmd);
      cp.exec(cmd, { cwd }, (err, stdout, stderr) => {
        if (err) {
          return reject(err);
        }
        if (log && stdout) {
          this._logger.info(stdout);
        }

        if (stderr) {
          this._logger.info(stderr);
        }
        return resolve(stdout);
      });
    });
  }

  private async execJson<T>(
    cmd: string,
    log: boolean = true,
    cwd?: string
  ): Promise<T> {
    const out = await this.exec(cmd, log, cwd);
    return JSON.parse(out.replaceAll(EOL, ""));
  }
}
