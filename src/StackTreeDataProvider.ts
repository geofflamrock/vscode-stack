import * as cp from "child_process";
import { EOL } from "os";
import pluralize from "pluralize";
import {
  Event,
  EventEmitter,
  LogOutputChannel,
  ProgressLocation,
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

  async pull(stack: StackTreeItem): Promise<void> {
    if (!this.workspaceRoot) {
      window.showInformationMessage("No stack in empty workspace");
      return;
    }
    window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Pulling changes for stack '${stack.stack.name}'`,
        cancellable: false,
      },
      async () => {
        try {
          await this.exec(
            `stack pull --stack ${stack.stack.name} --working-dir ${this.workspaceRoot}`
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
    window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Pushing changes for stack '${stack.stack.name}'`,
        cancellable: false,
      },
      async () => {
        try {
          await this.exec(
            `stack push --stack ${stack.stack.name} --working-dir ${
              this.workspaceRoot
            } ${forceWithLease ? "--force-with-lease" : ""}`
          );
        } catch (err) {
          window.showErrorMessage(`Error pushing changes: ${err}`);
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
      stackTreeItem.description = `${element.stack.sourceBranch} (${
        element.stack.branches.length
      } ${pluralize("branch", element.stack.branches.length)})`;
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
          element.status.aheadOfParent > 0 ||
          element.status.behindParent > 0
        ) {
          description += `${element.status.aheadOfParent}\u2193 ${element.status.behindParent}\u2191 `;
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
      window.showInformationMessage("No stack in empty workspace");
      return [];
    }

    if (!element) {
      const stacks = await this.execJson<Stack[]>(
        `stack status --all --json --working-dir ${this.workspaceRoot}`,
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

  private exec(cmd: string, log: boolean = true): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.logger.info(cmd);
      cp.exec(cmd, (err, out) => {
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

  private async execJson<T>(cmd: string, log: boolean = true): Promise<T> {
    const out = await this.exec(cmd, log);
    return JSON.parse(out.replaceAll(EOL, ""));
  }
}

// class StackTreeItemBase extends vscode.TreeItem {
//   constructor(
//     public readonly name: string,
//     public readonly description: string,
//     public readonly icon: vscode.ThemeIcon,
//     public readonly collapsibleState: vscode.TreeItemCollapsibleState
//   ) {
//     super(name, collapsibleState);
//     this.tooltip = `${this.name}`;
//     this.description = this.description;
//     this.iconPath = this.icon;
//   }
// }

// class StackTreeItem extends StackTreeItemBase {
//   constructor(
//     public readonly stack: Stack,
//     public readonly collapsibleState: vscode.TreeItemCollapsibleState
//   ) {
//     super(
//       stack.name,
//       `${stack.sourceBranch} (${stack.branches.length} ${pluralize(
//         "branch",
//         stack.branches.length
//       )})`,
//       new vscode.ThemeIcon("layers"),
//       collapsibleState
//     );
//   }
// }

// class BranchTreeItem extends StackTreeItemBase {
//   constructor(
//     public readonly branch: string,
//     public readonly collapsibleState: vscode.TreeItemCollapsibleState
//   ) {
//     super(branch, "", new vscode.ThemeIcon("git-branch"), collapsibleState);
//   }
// }
