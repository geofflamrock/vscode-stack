import * as cp from "child_process";
import { EOL } from "os";
import pluralize from "pluralize";
import {
  Event,
  EventEmitter,
  LogOutputChannel,
  ProgressLocation,
  QuickPickItem,
  QuickPickItemKind,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  window,
} from "vscode";

type Stack = {
  name: string;
  sourceBranch: string;
  branches: string[];
  status: StackStatus;
};

type StackStatus = {
  branches: StackBranchStatus;
};

type StackBranchStatus = {
  [name: string]: BranchDetail;
};

type BranchDetail = {
  status: BranchStatus;
};

type BranchStatus = {
  existsLocally: boolean;
  hasRemoteTrackingBranch: boolean;
  existsInRemote: boolean;
  aheadOfParent: number;
  behindParent: number;
  aheadOfRemote: number;
  behindRemote: number;
  tip: Commit;
};

type Commit = {
  sha: string;
  message: string;
};

export type StackTreeItem = {
  type: "stack";
  stack: Stack;
};

export type BranchTreeItem = {
  type: "branch";
  name: string;
  status?: BranchStatus;
};

export type StackTreeData = StackTreeItem | BranchTreeItem;

export class StackTreeDataProvider implements TreeDataProvider<StackTreeData> {
  constructor(
    private workspaceRoot: string | undefined,
    private logger: LogOutputChannel
  ) {}

  private _onDidChangeTreeData: EventEmitter<
    StackTreeData | undefined | null | void
  > = new EventEmitter<StackTreeData | undefined | null | void>();
  readonly onDidChangeTreeData: Event<StackTreeData | undefined | null | void> =
    this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async new(): Promise<void> {
    if (!this.workspaceRoot) {
      return;
    }
    const stackName = await window.showInputBox({ prompt: "Enter stack name" });

    if (!stackName) {
      return;
    }

    const branchesOrderedByCommitterDate =
      await this.getBranchesByCommitterDate(this.workspaceRoot);

    const sourceBranch = await window.showQuickPick(
      branchesOrderedByCommitterDate,
      {
        placeHolder: "Select source branch",
      }
    );

    if (!sourceBranch) {
      return;
    }

    const createNewBranchQuickPickItem: QuickPickItem = {
      label: "Create new branch",
      iconPath: new ThemeIcon("plus"),
    };
    const noNewBranchQuickPickItem: QuickPickItem = {
      label: "Do not create new branch",
      iconPath: new ThemeIcon("circle-slash"),
    };
    const separatorQuickPickItem: QuickPickItem = {
      label: "",
      kind: QuickPickItemKind.Separator,
    };
    const existingBranchesQuickPickItems: QuickPickItem[] =
      branchesOrderedByCommitterDate.map((branch) => ({
        label: branch,
        iconPath: new ThemeIcon("git-branch"),
      }));

    const branchNameSelection = await window.showQuickPick(
      [
        createNewBranchQuickPickItem,
        noNewBranchQuickPickItem,
        separatorQuickPickItem,
        ...existingBranchesQuickPickItems,
      ],
      {
        placeHolder: "Create or select a branch to add to the stack",
      }
    );

    if (branchNameSelection === undefined) {
      return;
    }

    let branchName: string | undefined = undefined;

    if (branchNameSelection === createNewBranchQuickPickItem) {
      branchName = await window.showInputBox({
        prompt: "Enter new branch name",
      });

      if (!branchName) {
        return;
      }
    } else if (branchNameSelection !== noNewBranchQuickPickItem) {
      branchName = branchNameSelection.label;
    }

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Creating stack '${stackName}'`,
        cancellable: false,
      },
      async () => {
        try {
          let cmd = `stack new --name "${stackName}" --source-branch "${sourceBranch}" --working-dir "${this.workspaceRoot}" --yes`;

          if (branchName) {
            cmd += ` --branch ${branchName}`;
          }
          await this.exec(cmd);
        } catch (err) {
          window.showErrorMessage(`Error creating stack: ${err}`);
          throw err;
        }
      }
    );

    this.refresh();
  }

  async pull(stack: StackTreeItem): Promise<void> {
    if (!this.workspaceRoot) {
      window.showInformationMessage("No stack in empty workspace");
      return;
    }
    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Pulling changes for stack '${stack.stack.name}'`,
        cancellable: false,
      },
      async () => {
        try {
          await this.exec(
            `stack pull --stack "${stack.stack.name}" --working-dir "${this.workspaceRoot}"`
          );
        } catch (err) {
          window.showErrorMessage(`Error pulling changes: ${err}`);
        }
      }
    );
  }

  async push(stack: StackTreeItem, forceWithLease: boolean): Promise<void> {
    if (!this.workspaceRoot) {
      window.showInformationMessage("No stack in empty workspace");
      return;
    }
    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Pushing changes for stack '${stack.stack.name}'`,
        cancellable: false,
      },
      async () => {
        try {
          await this.exec(
            `stack push --stack "${stack.stack.name}" --working-dir "${
              this.workspaceRoot
            }" ${forceWithLease ? "--force-with-lease" : ""}`
          );
        } catch (err) {
          window.showErrorMessage(`Error pushing changes: ${err}`);
        }
      }
    );
  }

  async delete(stack: StackTreeItem): Promise<void> {
    if (!this.workspaceRoot) {
      window.showInformationMessage("No stack in empty workspace");
      return;
    }

    const deleteStack: QuickPickItem = {
      label: "Delete Stack",
      detail:
        "Will delete the stack and any branches which are no longer on the remote",
    };

    const separator: QuickPickItem = {
      label: "",
      kind: QuickPickItemKind.Separator,
    };

    const cancel: QuickPickItem = {
      label: "Cancel",
    };

    const confirm = await window.showQuickPick(
      [deleteStack, separator, cancel],
      {
        placeHolder: `Are you sure you want to delete stack '${stack.stack.name}'?`,
        title: "Confirm delete stack",
      }
    );

    if (confirm !== deleteStack) {
      return;
    }

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Deleting stack '${stack.stack.name}'`,
        cancellable: false,
      },
      async () => {
        try {
          await this.exec(
            `stack delete --stack "${stack.stack.name}" --working-dir "${this.workspaceRoot}" --yes`
          );
        } catch (err) {
          window.showErrorMessage(`Error deleting stack: ${err}`);
          throw err;
        }
      }
    );

    this.refresh();
  }

  async switchTo(branch: BranchTreeItem): Promise<void> {
    if (!this.workspaceRoot) {
      window.showInformationMessage("No stack in empty workspace");
      return;
    }
    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Switching to branch '${branch.name}'`,
        cancellable: false,
      },
      async () => {
        try {
          await this.exec(
            `stack switch --branch "${branch.name}" --working-dir "${this.workspaceRoot}"`
          );
        } catch (err) {
          window.showErrorMessage(`Error switching to branch: ${err}`);
        }
      }
    );
  }

  getTreeItem(element: StackTreeData): TreeItem {
    if (element.type === "stack") {
      const stackTreeItem = new TreeItem(
        element.stack.name,
        TreeItemCollapsibleState.Collapsed
      );
      stackTreeItem.id = element.stack.name;
      stackTreeItem.iconPath = new ThemeIcon("layers");

      const sourceBranchDetails =
        element.stack.status.branches[element.stack.sourceBranch];
      let description = element.stack.sourceBranch;
      if (sourceBranchDetails) {
        if (
          sourceBranchDetails.status.aheadOfRemote > 0 ||
          sourceBranchDetails.status.behindRemote > 0
        ) {
          description += `  ${sourceBranchDetails.status.behindRemote}\u2193 ${sourceBranchDetails.status.aheadOfRemote}\u2191`;
        }
        description += `  \u21c6  origin/${element.stack.sourceBranch}`;
      }

      description += ` (${element.stack.branches.length} ${pluralize(
        "branch",
        element.stack.branches.length
      )})`;
      stackTreeItem.description = description;
      stackTreeItem.contextValue = "stack";
      return stackTreeItem;
    } else if (element.type === "branch") {
      const branchTreeItem = new TreeItem(
        element.name,
        TreeItemCollapsibleState.None
      );
      branchTreeItem.iconPath = new ThemeIcon("git-branch");
      branchTreeItem.contextValue = "branch";
      if (element.status) {
        let description = "";
        if (
          element.status.aheadOfRemote > 0 ||
          element.status.behindRemote > 0
        ) {
          description += `${element.status.behindRemote}\u2193 ${element.status.aheadOfRemote}\u2191 `;
        }

        description += ` \u21c6  origin/${element.name}`;
        branchTreeItem.description = description;
      }
      return branchTreeItem;
    }

    return new TreeItem("Unknown");
  }

  async getChildren(element?: StackTreeData): Promise<StackTreeData[]> {
    if (!this.workspaceRoot) {
      return [];
    }

    if (!element) {
      const stacks = await this.execJson<Stack[]>(
        `stack status --all --json --working-dir "${this.workspaceRoot}"`,
        false
      );

      return stacks.map((stack) => {
        return {
          type: "stack",
          stack,
        };
      });
    } else {
      if (element.type === "stack") {
        const branches: BranchTreeItem[] = element.stack.branches.map(
          (name) => {
            const branchStatus = element.stack.status.branches[name];
            return {
              type: "branch",
              name: name,
              status: branchStatus ? branchStatus.status : undefined,
            };
          }
        );

        return branches;
      }
    }

    return [];
  }

  private exec(
    cmd: string,
    log: boolean = true,
    cwd?: string
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.logger.info(cmd);
      cp.exec(cmd, { cwd }, (err, out) => {
        if (err) {
          return reject(err);
        }
        if (log) {
          this.logger.info(out);
        }
        return resolve(out);
      });
    });
  }

  private async execJson<T>(
    cmd: string,
    log: boolean = true,
    cwd?: string
  ): Promise<T> {
    const out = await this.exec(cmd, log);
    return JSON.parse(out.replaceAll(EOL, ""));
  }

  private async getBranchesByCommitterDate(cwd?: string): Promise<string[]> {
    const branches = await this.exec(
      `git branch --list --format=%(refname:short) --sort=-committerdate`,
      false,
      cwd
    );
    return branches.split("\n").filter((branch) => branch.length > 0);
  }
}
