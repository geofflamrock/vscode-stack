import * as cp from "child_process";
import { EOL } from "os";
import pluralize from "pluralize";
import {
  commands,
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
import { Stack, GitHubPullRequest, Branch } from "./types";
import { canCompareBranchToParent } from "./types/Branch";
import { Repository } from "./typings/git";

export type StackTreeItem = {
  type: "stack";
  stack: Stack;
};

export type BranchTreeItem = {
  type: "branch";
  stack: Stack;
  branch: Branch;
};

export type ParentStatusTreeItem = {
  type: "branchParentStatus";
  parentBranchName: string;
  aheadOfParent: number;
  behindParent: number;
};

export type PullRequestTreeItem = {
  type: "pullRequest";
  pullRequest: GitHubPullRequest;
};

export type StackTreeData =
  | StackTreeItem
  | BranchTreeItem
  | ParentStatusTreeItem
  | PullRequestTreeItem;

const enum GlyphChars {
  ArrowDown = "\u2193",
  ArrowUp = "\u2191",
  ArrowLeftRight = "\u21c6",
}

export class StackTreeDataProvider implements TreeDataProvider<StackTreeData> {
  constructor(
    private repository: Repository,
    private logger: LogOutputChannel
  ) {
    this._workspaceRoot = this.repository.rootUri.fsPath;
  }

  private _onDidChangeTreeData: EventEmitter<
    StackTreeData | undefined | null | void
  > = new EventEmitter<StackTreeData | undefined | null | void>();
  readonly onDidChangeTreeData: Event<StackTreeData | undefined | null | void> =
    this._onDidChangeTreeData.event;
  private _workspaceRoot;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async newStack(): Promise<void> {
    const stackName = await window.showInputBox({ prompt: "Enter stack name" });

    if (!stackName) {
      return;
    }

    const branchesOrderedByCommitterDate =
      await this.getBranchesByCommitterDate(this._workspaceRoot);

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
      label: "Do not create or add a branch",
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
          let cmd = `stack new --name "${stackName}" --source-branch "${sourceBranch}" --working-dir "${this._workspaceRoot}"`;

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

  async newBranch(stack: StackTreeItem): Promise<void> {
    const branchesOrderedByCommitterDate =
      await this.getBranchesByCommitterDate(this.repository.rootUri.fsPath);

    const createNewBranchQuickPickItem: QuickPickItem = {
      label: "Create new branch",
      iconPath: new ThemeIcon("plus"),
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

      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `Creating new branch '${branchName}' in stack '${stack.stack.name}'`,
          cancellable: false,
        },
        async () => {
          try {
            let cmd = `stack branch new --stack "${stack.stack.name}" --name "${branchName}" --working-dir "${this._workspaceRoot}"`;
            await this.exec(cmd);
          } catch (err) {
            window.showErrorMessage(`Error creating branch in stack: ${err}`);
            throw err;
          }
        }
      );
    } else {
      branchName = branchNameSelection.label;

      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `Adding branch '${branchName}' to stack '${stack.stack.name}'`,
          cancellable: false,
        },
        async () => {
          try {
            let cmd = `stack branch add --stack "${stack.stack.name}" --name "${branchName}" --working-dir "${this._workspaceRoot}"`;
            await this.exec(cmd);
          } catch (err) {
            window.showErrorMessage(`Error adding branch to stack: ${err}`);
            throw err;
          }
        }
      );
    }

    this.refresh();
  }

  async sync(stack: StackTreeItem): Promise<void> {
    const syncStack: QuickPickItem = {
      label: "Sync Stack",
      detail:
        "Will fetch the latest changes from the remote, update the stack and push commits back to the remote",
    };

    const separator: QuickPickItem = {
      label: "",
      kind: QuickPickItemKind.Separator,
    };

    const cancel: QuickPickItem = {
      label: "Cancel",
    };

    const confirm = await window.showQuickPick([syncStack, separator, cancel], {
      placeHolder: `Are you sure you want to sync stack '${stack.stack.name}'?`,
      title: "Confirm Sync Stack",
    });

    if (confirm !== syncStack) {
      return;
    }

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Syncing stack '${stack.stack.name}' with remote`,
        cancellable: false,
      },
      async () => {
        try {
          await this.exec(
            `stack sync --stack "${stack.stack.name}" --working-dir "${this._workspaceRoot}" --yes`
          );

          this.refresh();
        } catch (err) {
          window.showErrorMessage(`Error syncing changes: ${err}`);
        }
      }
    );
  }

  async update(stack: StackTreeItem): Promise<void> {
    const syncStack: QuickPickItem = {
      label: "Update Stack",
      detail:
        "Will update branches in the stack locally, does not pull changes from or push changes to the remote",
    };

    const separator: QuickPickItem = {
      label: "",
      kind: QuickPickItemKind.Separator,
    };

    const cancel: QuickPickItem = {
      label: "Cancel",
    };

    const confirm = await window.showQuickPick([syncStack, separator, cancel], {
      placeHolder: `Are you sure you want to update stack '${stack.stack.name}'?`,
      title: "Confirm Update Stack",
    });

    if (confirm !== syncStack) {
      return;
    }

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Updating stack '${stack.stack.name}' with remote`,
        cancellable: false,
      },
      async () => {
        try {
          await this.exec(
            `stack update --stack "${stack.stack.name}" --working-dir "${this._workspaceRoot}"`
          );
        } catch (err) {
          window.showErrorMessage(`Error updating changes: ${err}`);
          throw err;
        }
      }
    );

    this.refresh();
  }

  async pull(stack: StackTreeItem): Promise<void> {
    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Pulling changes for stack '${stack.stack.name}'`,
        cancellable: false,
      },
      async () => {
        try {
          await this.exec(
            `stack pull --stack "${stack.stack.name}" --working-dir "${this._workspaceRoot}"`
          );

          this.refresh();
        } catch (err) {
          window.showErrorMessage(`Error pulling changes: ${err}`);
        }
      }
    );
  }

  async push(stack: StackTreeItem, forceWithLease: boolean): Promise<void> {
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
              this._workspaceRoot
            }" ${forceWithLease ? "--force-with-lease" : ""}`
          );

          this.refresh();
        } catch (err) {
          window.showErrorMessage(`Error pushing changes: ${err}`);
        }
      }
    );
  }

  async delete(stack: StackTreeItem): Promise<void> {
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
        title: "Confirm Delete Stack",
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
            `stack delete --stack "${stack.stack.name}" --working-dir "${this._workspaceRoot}" --yes`
          );
        } catch (err) {
          window.showErrorMessage(`Error deleting stack: ${err}`);
          throw err;
        }
      }
    );

    this.refresh();
  }

  async cleanup(stack: StackTreeItem): Promise<void> {
    const cleanupStack: QuickPickItem = {
      label: "Cleanup Stack",
      detail: "Will delete any branches which are no longer on the remote",
    };

    const separator: QuickPickItem = {
      label: "",
      kind: QuickPickItemKind.Separator,
    };

    const cancel: QuickPickItem = {
      label: "Cancel",
    };

    const confirm = await window.showQuickPick(
      [cleanupStack, separator, cancel],
      {
        placeHolder: `Are you sure you want to cleanup stack '${stack.stack.name}'?`,
        title: "Confirm Cleanup Stack",
      }
    );

    if (confirm !== cleanupStack) {
      return;
    }

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Cleaning up stack '${stack.stack.name}'`,
        cancellable: false,
      },
      async () => {
        try {
          await this.exec(
            `stack cleanup --stack "${stack.stack.name}" --working-dir "${this._workspaceRoot}" --yes`
          );
        } catch (err) {
          window.showErrorMessage(`Error cleaning up stack: ${err}`);
          throw err;
        }
      }
    );

    this.refresh();
  }

  async switchTo(branch: string): Promise<void> {
    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Switching to branch '${branch}'`,
        cancellable: false,
      },
      async () => {
        try {
          await this.exec(
            `stack switch --branch "${branch}" --working-dir "${this._workspaceRoot}"`
          );
        } catch (err) {
          window.showErrorMessage(`Error switching to branch: ${err}`);
        }
      }
    );
  }

  async removeBranchFromStack(branch: BranchTreeItem): Promise<void> {
    const removeBranchFromStack: QuickPickItem = {
      label: "Remove Branch",
      detail: "The branch will not be deleted, only removed from the stack.",
    };

    const separator: QuickPickItem = {
      label: "",
      kind: QuickPickItemKind.Separator,
    };

    const cancel: QuickPickItem = {
      label: "Cancel",
    };

    const confirm = await window.showQuickPick(
      [removeBranchFromStack, separator, cancel],
      {
        placeHolder: `Are you sure you want to remove branch '${branch.branch.name}' from stack '${branch.stack.name}'?`,
        title: "Confirm Remove Branch",
      }
    );

    if (confirm !== removeBranchFromStack) {
      return;
    }

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Removing branch '${branch.branch.name}' from stack '${branch.stack.name}'`,
        cancellable: false,
      },
      async () => {
        try {
          await this.exec(
            `stack branch remove --stack "${branch.stack.name}" --name "${branch.branch.name}" --working-dir "${this._workspaceRoot}" --yes`
          );
        } catch (err) {
          window.showErrorMessage(`Error switching to branch: ${err}`);
        }
      }
    );

    this.refresh();
  }

  openPullRequest(pullRequest: PullRequestTreeItem): void {
    commands.executeCommand("vscode.open", pullRequest.pullRequest.url);
  }

  getTreeItem(element: StackTreeData): TreeItem {
    if (element.type === "stack") {
      const stackTreeItem = new TreeItem(
        element.stack.name,
        TreeItemCollapsibleState.Collapsed
      );
      stackTreeItem.id = element.stack.name;
      stackTreeItem.iconPath = new ThemeIcon("layers");

      let description = element.stack.sourceBranch.name;
      if (element.stack.sourceBranch.remoteTrackingBranch) {
        if (
          element.stack.sourceBranch.remoteTrackingBranch.ahead > 0 ||
          element.stack.sourceBranch.remoteTrackingBranch.behind > 0
        ) {
          description += `  ${element.stack.sourceBranch.remoteTrackingBranch.behind}${GlyphChars.ArrowDown} ${element.stack.sourceBranch.remoteTrackingBranch.ahead}${GlyphChars.ArrowUp}`;
        }
        description += `  ${GlyphChars.ArrowLeftRight}  ${element.stack.sourceBranch.remoteTrackingBranch.name}`;
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
        element.branch.name,
        canCompareBranchToParent(element.branch)
          ? TreeItemCollapsibleState.Collapsed
          : TreeItemCollapsibleState.None
      );
      branchTreeItem.iconPath = new ThemeIcon("git-branch");
      branchTreeItem.contextValue = `branch.${
        element.branch.exists ? "exists" : "deleted"
      }`;
      if (!element.branch.exists) {
        branchTreeItem.description = "(deleted)";
      } else if (element.branch.remoteTrackingBranch) {
        let description = "";
        if (element.branch.remoteTrackingBranch.exists) {
          if (
            element.branch.remoteTrackingBranch.ahead > 0 ||
            element.branch.remoteTrackingBranch.behind > 0
          ) {
            description += `${element.branch.remoteTrackingBranch.behind}${GlyphChars.ArrowDown} ${element.branch.remoteTrackingBranch.ahead}${GlyphChars.ArrowUp} `;
          }
        }

        description += ` ${GlyphChars.ArrowLeftRight}  ${
          element.branch.remoteTrackingBranch.name
        }${element.branch.remoteTrackingBranch.exists ? "" : " (deleted)"}`;
        branchTreeItem.description = description;
      }
      return branchTreeItem;
    } else if (element.type === "branchParentStatus") {
      const branchParentStatusTreeItem = new TreeItem(
        `${element.aheadOfParent} ahead, ${element.behindParent} behind ${element.parentBranchName}`,
        TreeItemCollapsibleState.None
      );
      branchParentStatusTreeItem.iconPath = new ThemeIcon("git-compare");
      return branchParentStatusTreeItem;
    } else if (element.type === "pullRequest") {
      const pullRequestTreeItem = new TreeItem(
        `#${element.pullRequest.number}: ${element.pullRequest.title}`,
        TreeItemCollapsibleState.None
      );
      pullRequestTreeItem.contextValue = "pullRequest";
      pullRequestTreeItem.iconPath = new ThemeIcon("git-pull-request");
      return pullRequestTreeItem;
    }

    return new TreeItem("Unknown");
  }

  async getChildren(element?: StackTreeData): Promise<StackTreeData[]> {
    if (!element) {
      const stacks = await this.execJson<Stack[]>(
        `stack status --all --json --working-dir "${this._workspaceRoot}"`,
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
        const stackDetails = element.stack;

        // try {
        //   const stackStatus = await this.execJson<Stack2[]>(
        //     `stack status --stack "${element.stack.name}" --json --full --working-dir "${this.workspaceRoot}"`,
        //     false
        //   );

        //   if (stackStatus.length !== 1) {
        //     return [];
        //   }

        //   stackDetails = stackStatus[0];
        // } catch (err) {
        //   this.logger.warn(
        //     "An error has occurred getting full status for stack"
        //   );
        //   stackDetails = element.stack;
        // }

        const branches: BranchTreeItem[] = stackDetails.branches.map(
          (branch) => {
            return {
              type: "branch",
              stack: element.stack,
              branch,
            };
          }
        );

        return branches;
      } else if (element.type === "branch") {
        if (canCompareBranchToParent(element.branch)) {
          // Get the previous branch in the stack
          const branches = element.stack.branches;
          const branchIndex = branches.indexOf(element.branch);
          const parentBranch =
            branchIndex > 0
              ? branches[branchIndex - 1]
              : element.stack.sourceBranch;

          const aheadOfParent = element.branch.parent?.ahead ?? 0;
          const behindParent =
            (element.branch.parent?.behind ?? 0) +
            (parentBranch.remoteTrackingBranch?.behind ?? 0);

          const branchParentStatusTreeItem: ParentStatusTreeItem = {
            type: "branchParentStatus",
            parentBranchName:
              parentBranch.remoteTrackingBranch?.name ?? parentBranch.name,
            aheadOfParent: aheadOfParent,
            behindParent: behindParent,
          };

          const treeItems: StackTreeData[] = [branchParentStatusTreeItem];

          if (element.branch.pullRequest) {
            treeItems.push({
              type: "pullRequest",
              pullRequest: element.branch.pullRequest,
            });
          }

          return treeItems;
        }

        return [];
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
      cp.exec(cmd, { cwd }, (err, stdout, stderr) => {
        if (err) {
          return reject(err);
        }
        if (log && stdout) {
          this.logger.info(stdout);
        }

        if (stderr) {
          this.logger.info(stderr);
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

  private async getBranchesByCommitterDate(cwd?: string): Promise<string[]> {
    const branches = await this.exec(
      `git branch --list --format=%(refname:short) --sort=-committerdate`,
      false,
      cwd
    );
    return branches.split("\n").filter((branch) => branch.length > 0);
  }
}
