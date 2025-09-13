import { LogOutputChannel } from "vscode";
import { Stack, StackSummary } from "../types";
import { Repository } from "../typings/git";
import * as cp from "child_process";
import { EOL } from "os";

type UpdateStrategy = "merge" | "rebase";

// Structured log event emitted on stderr by the stack CLI.
// Allow unknown extra properties while strongly typing the primary ones we use.
interface StackCliLogEvent {
    EventId: number;
    LogLevel: "Trace" | "Debug" | "Information" | "Warning" | "Error" | "Critical";
    Category: string;
    Message: string;
}

const StackCliEvents = {
    Status: 1,
    Success: 2,
};

export interface IStackApi {
    getStacks(): Promise<Stack[]>;
    getStackSummaries(): Promise<StackSummary[]>;
    getBranchesByCommitterDate(): Promise<string[]>;
    getUpdateStrategyFromConfig(): Promise<UpdateStrategy | undefined>;
    // Subscribe to streaming status messages emitted by the stack CLI (EventId === 1)
    onStatus(listener: (status: string) => void): void;

    newStack(name: string, sourceBranch: string, branchName?: string): Promise<void>;

    newBranch(stack: string, name: string, parent: string): Promise<void>;
    addBranch(stack: string, name: string, parent: string): Promise<void>;
    removeBranch(stack: string, name: string): Promise<void>;

    sync(stack: string, updateStrategy?: UpdateStrategy): Promise<void>;
    pull(stack: string): Promise<void>;
    push(stack: string, forceWithLease: boolean): Promise<void>;

    update(stack: string, updateStrategy?: UpdateStrategy): Promise<void>;
    delete(stack: string): Promise<void>;
    cleanup(stack: string): Promise<void>;

    switchToBranch(branch: string): Promise<void>;
}

export class StackApi implements IStackApi {
    constructor(
        private readonly _repository: Repository,
        private readonly _logger: LogOutputChannel,
    ) {}

    // Buffer for partial stderr line fragments while streaming
    private _stderrLineBuffer: string = "";
    // Registered listeners for status messages (EventId === 1)
    private _statusListeners: Array<(status: string) => void> = [];

    public onStatus(listener: (status: string) => void): void {
        this._statusListeners.push(listener);
    }

    private workingDirectory(): string {
        return this._repository.rootUri.fsPath;
    }

    async getStacks(): Promise<Stack[]> {
        const stacks = await this.execJson<Stack[]>(
            `stack status --all --json --working-dir "${this.workingDirectory()}"`,
            false,
        );

        return stacks;
    }

    async getStackSummaries(): Promise<StackSummary[]> {
        const result = await this.execJson<{ stacks: StackSummary[] }>(
            `stack list --json --working-dir "${this.workingDirectory()}"`,
            false,
        );
        return result.stacks || [];
    }

    async getBranchesByCommitterDate(): Promise<string[]> {
        const branches = await this._repository.getBranches({});
        return branches.filter((branch) => branch.name).map((branch) => branch.name!);
    }

    async getUpdateStrategyFromConfig(): Promise<UpdateStrategy | undefined> {
        const localConfig = await this._repository.getConfig("stack.update.strategy");

        if (localConfig === "merge") {
            return "merge";
        }
        if (localConfig === "rebase") {
            return "rebase";
        }

        const globalConfig = await this._repository.getGlobalConfig("stack.update.strategy");

        if (globalConfig === "merge") {
            return "merge";
        }
        if (globalConfig === "rebase") {
            return "rebase";
        }

        return undefined;
    }

    async newStack(name: string, sourceBranch: string, branchName?: string): Promise<void> {
        let cmd = `stack new --name "${name}" --source-branch "${sourceBranch}" --working-dir "${this.workingDirectory()}" --json`;

        if (branchName) {
            cmd += ` --branch ${branchName}`;
        }

        this.exec(cmd);
    }

    async newBranch(stack: string, name: string, parent: string): Promise<void> {
        let cmd = `stack branch new --stack "${stack}" --branch "${name}" --parent "${parent}" --working-dir "${this.workingDirectory()}" --json`;
        await this.exec(cmd);
    }

    async addBranch(stack: string, name: string, parent: string): Promise<void> {
        let cmd = `stack branch add --stack "${stack}" --branch "${name}" --parent "${parent}" --working-dir "${this.workingDirectory()}" --json`;
        await this.exec(cmd);
    }

    async removeBranch(stack: string, name: string): Promise<void> {
        let cmd = `stack branch remove --stack "${stack}" --branch "${name}" --working-dir "${this.workingDirectory()}" --yes --json`;
        await this.exec(cmd);
    }

    async sync(stack: string, updateStrategy?: UpdateStrategy): Promise<void> {
        await this.exec(
            `stack sync --stack "${stack}" --working-dir "${this.workingDirectory()}" --yes${
                updateStrategy ? ` --${updateStrategy}` : ""
            } --json`,
        );
    }

    async pull(stack: string): Promise<void> {
        await this.exec(
            `stack pull --stack "${stack}" --working-dir "${this.workingDirectory()}" --json`,
        );
    }

    async push(stack: string, forceWithLease: boolean): Promise<void> {
        await this.exec(
            `stack push --stack "${stack}" --working-dir "${this.workingDirectory()}" ${
                forceWithLease ? "--force-with-lease" : ""
            } --json`,
        );
    }

    async update(stack: string, updateStrategy?: UpdateStrategy): Promise<void> {
        await this.exec(
            `stack update --stack "${stack}" --working-dir "${this.workingDirectory()}"${
                updateStrategy ? ` --${updateStrategy}` : ""
            } --json`,
        );
    }

    async delete(stack: string): Promise<void> {
        await this.exec(
            `stack delete --stack "${stack}" --working-dir "${this.workingDirectory()}" --yes --json`,
        );
    }

    async cleanup(stack: string): Promise<void> {
        await this.exec(
            `stack cleanup --stack "${stack}" --working-dir "${this.workingDirectory()}" --yes --json`,
        );
    }

    async switchToBranch(branch: string): Promise<void> {
        await this.exec(
            `stack switch --branch "${branch}" --working-dir "${this.workingDirectory()}" --json`,
        );
    }

    private exec(cmd: string, log: boolean = true, cwd?: string): Promise<string> {
        // Use spawn so we can stream stderr (and stdout) incrementally to the log output channel.
        // Previous implementation buffered output via exec and only logged at completion.
        return new Promise<string>((resolve, reject) => {
            this._logger.info(`[command] ${cmd}`);
            const child = cp.spawn(cmd, { cwd, shell: true });

            let stdoutBuffer = "";
            let stderrBuffer = ""; // kept in case we want to surface richer errors

            child.stdout.on("data", (data: Buffer) => {
                const text = data.toString();
                stdoutBuffer += text;
                if (log && text) {
                    this._logger.info(text);
                }
            });

            child.stderr.on("data", (data: Buffer) => {
                const chunk = data.toString();
                stderrBuffer += chunk;
                if (!chunk) {
                    return;
                }

                // We may receive partial lines; buffer and process line-by-line
                this._stderrLineBuffer += chunk;
                const buffer: string = this._stderrLineBuffer;
                const lines = buffer.split(/\r?\n/);
                // Keep last partial (if last char not newline)
                this._stderrLineBuffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) {
                        continue;
                    }

                    let parsed: StackCliLogEvent | undefined;
                    try {
                        parsed = JSON.parse(trimmed);
                    } catch {
                        // Not JSON; log raw line and continue
                        this._logger.info(trimmed);
                        continue;
                    }

                    if (parsed === undefined) {
                        continue;
                    }

                    let prefix = "";

                    switch (parsed.EventId) {
                        case StackCliEvents.Status:
                            prefix = "[status] ";
                            break;
                        case StackCliEvents.Success:
                            prefix = "[success] ";
                            break;
                        default:
                            prefix = "";
                            break;
                    }

                    // Map external log level to VS Code LogOutputChannel methods
                    switch (parsed.LogLevel) {
                        case "Trace":
                            this._logger.trace(`${prefix}${parsed.Message}`);
                            break;
                        case "Debug":
                            this._logger.debug(`${prefix}${parsed.Message}`);
                            break;
                        case "Information":
                            this._logger.info(`${prefix}${parsed.Message}`);
                            break;
                        case "Warning":
                            this._logger.warn(`${prefix}${parsed.Message}`);
                            break;
                        case "Error":
                        case "Critical":
                            this._logger.error(`${prefix}${parsed.Message}`);
                            break;
                        default:
                            this._logger.info(`${prefix}${parsed.Message}`);
                            break;
                    }

                    // EventId === 1 indicates a streaming status update from the CLI
                    if (parsed.EventId === StackCliEvents.Status && parsed.Message) {
                        for (const listener of this._statusListeners) {
                            try {
                                listener(parsed.Message);
                            } catch {
                                // Swallow listener errors so they don't break streaming
                            }
                        }
                    }
                }
            });

            child.on("error", (err) => {
                // Include any accumulated stderr to aid debugging
                if (stderrBuffer) {
                    this._logger.info(stderrBuffer);
                }
                reject(err);
            });

            child.on("close", (code) => {
                if (code === 0) {
                    return resolve(stdoutBuffer);
                }
                const error = new Error(
                    `Command failed (exit code ${code}): ${cmd}${stderrBuffer ? "\n" + stderrBuffer : ""}`,
                );
                reject(error);
            });
        });
    }

    private async execJson<T>(cmd: string, log: boolean = true, cwd?: string): Promise<T> {
        const out = await this.exec(cmd, log, cwd);
        return JSON.parse(out.replaceAll(EOL, ""));
    }
}
