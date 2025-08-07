import pluralize from "pluralize";
import {
  commands,
  Event,
  EventEmitter,
  ProgressLocation,
  QuickPickItem,
  QuickPickItemKind,
  ThemeColor,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  window,
} from "vscode";
import {
  Stack,
  GitHubPullRequest,
  StackBranch,
  canCompareBranchToParent,
} from "./types";
import { IStackApi } from "./stack";
import { StackCache } from "./stack/stackCache";

export type StackTreeItem = {
  type: "stack";
  stack: Stack;
};

export type RepositoryTreeItem = {
  type: "repository";
  repositoryName: string;
  repositoryPath: string;
  stacks?: Stack[]; // Optional - only populated when loaded
};

export type BranchTreeItem = {
  type: "branch";
  stack: Stack;
  branch: StackBranch;
};

export type ChildBranchesTreeItem = {
  type: "childBranches";
  stack: Stack;
  children: StackBranch[];
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
  | RepositoryTreeItem
  | StackTreeItem
  | BranchTreeItem
  | ChildBranchesTreeItem
  | ParentStatusTreeItem
  | PullRequestTreeItem;

const enum GlyphChars {
  ArrowDown = "\u2193",
  ArrowUp = "\u2191",
  ArrowLeftRight = "\u21c6",
}

export class StackTreeDataProvider implements TreeDataProvider<StackTreeData> {
  private stackCaches: Map<string, StackCache> = new Map();
  private apis: Map<string, IStackApi> = new Map();
  private repositoryStackCounts: Map<string, number> = new Map();
  private loadingStackCounts: Set<string> = new Set(); // Track which repos are currently loading

  constructor() {}

  addRepository(
    repositoryPath: string,
    repositoryName: string,
    api: IStackApi
  ): void {
    this.apis.set(repositoryPath, api);
    this.stackCaches.set(repositoryPath, new StackCache(api));

    // Asynchronously load stack count for this repository
    this.loadRepositoryStackCount(repositoryPath);
  }

  removeRepository(repositoryPath: string): void {
    this.apis.delete(repositoryPath);
    this.stackCaches.delete(repositoryPath);
    this.repositoryStackCounts.delete(repositoryPath);
    this.loadingStackCounts.delete(repositoryPath);
  }

  getApiForRepository(repositoryPath: string): IStackApi | undefined {
    return this.apis.get(repositoryPath);
  }

  private getDefaultApi(): IStackApi | undefined {
    // Return the first available API if only one repository
    if (this.apis.size === 1) {
      return Array.from(this.apis.values())[0];
    }

    // For multiple repositories, we'll need to determine which one to use
    // For now, return the first one as a fallback
    return Array.from(this.apis.values())[0];
  }

  private getApiForStack(stack: Stack): IStackApi | undefined {
    // If stack has repository info, use that
    if (stack.repositoryName) {
      for (const [path, api] of this.apis.entries()) {
        const repoName =
          path.split("\\").pop() || path.split("/").pop() || path;
        if (repoName === stack.repositoryName) {
          return api;
        }
      }
    }

    // Fallback to default API
    return this.getDefaultApi();
  }

  private _onDidChangeTreeData: EventEmitter<
    StackTreeData | undefined | null | void
  > = new EventEmitter<StackTreeData | undefined | null | void>();
  readonly onDidChangeTreeData: Event<StackTreeData | undefined | null | void> =
    this._onDidChangeTreeData.event;

  refresh(): void {
    this.stackCaches.forEach((cache) => cache.clearCache());
    this.repositoryStackCounts.clear();
    this.loadingStackCounts.clear(); // Clear loading flags
    this._onDidChangeTreeData.fire();

    // Note: Stack counts will be loaded on-demand by getChildren() when the tree is rendered
  }

  async refreshRepositoryStackCounts(): Promise<void> {
    // This method can be called to update repository descriptions with stack counts
    // after initial lazy loading
    this._onDidChangeTreeData.fire();
  }

  private async loadRepositoryStackCount(
    repositoryPath: string
  ): Promise<void> {
    // Prevent duplicate loading
    if (this.loadingStackCounts.has(repositoryPath)) {
      return;
    }

    try {
      this.loadingStackCounts.add(repositoryPath);
      const api = this.apis.get(repositoryPath);
      if (api) {
        // Use the faster stack list command to get just the count
        const stackList = await api.getStackListWithMetadata();
        this.repositoryStackCounts.set(repositoryPath, stackList.length);
        // Fire event to update the tree item description
        this._onDidChangeTreeData.fire();
      }
    } catch (error) {
      // Silently handle errors - the count just won't be shown
    } finally {
      this.loadingStackCounts.delete(repositoryPath);
    }
  }

  async newStack(): Promise<void> {
    if (this.apis.size === 0) {
      window.showErrorMessage("No repository available for creating stacks");
      return;
    }

    let selectedApi: IStackApi;
    let selectedRepoPath: string;

    // If multiple repositories, let user choose
    if (this.apis.size > 1) {
      const repositoryOptions = Array.from(this.apis.entries()).map(
        ([path, api]) => {
          const repoName =
            path.split("\\").pop() || path.split("/").pop() || path;
          return {
            label: repoName,
            description: path,
            path: path,
            api: api,
          };
        }
      );

      const selectedRepo = await window.showQuickPick(repositoryOptions, {
        placeHolder: "Select repository for the new stack",
        title: "Choose Repository",
      });

      if (!selectedRepo) {
        return;
      }

      selectedApi = selectedRepo.api;
      selectedRepoPath = selectedRepo.path;
    } else {
      // Single repository
      const entry = Array.from(this.apis.entries())[0];
      selectedApi = entry[1];
      selectedRepoPath = entry[0];
    }

    const stackName = await window.showInputBox({ prompt: "Enter stack name" });

    if (!stackName) {
      return;
    }

    const branchesOrderedByCommitterDate =
      await selectedApi.getBranchesByCommitterDate();

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
          await selectedApi.newStack(stackName, sourceBranch, branchName);
        } catch (err) {
          window.showErrorMessage(`Error creating stack: ${err}`);
          throw err;
        }
      }
    );

    this.refresh();
  }

  async newStackInRepository(repositoryPath: string): Promise<void> {
    const api = this.apis.get(repositoryPath);
    if (!api) {
      window.showErrorMessage("Repository not found or not available");
      return;
    }

    const stackName = await window.showInputBox({ prompt: "Enter stack name" });

    if (!stackName) {
      return;
    }

    const branchesOrderedByCommitterDate =
      await api.getBranchesByCommitterDate();

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
      branchesOrderedByCommitterDate.map((branch: string) => ({
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
          await api.newStack(stackName, sourceBranch, branchName);
        } catch (err) {
          window.showErrorMessage(`Error creating stack: ${err}`);
          throw err;
        }
      }
    );

    this.refresh();
  }

  async newBranch(
    stackOrBranch: StackTreeItem | BranchTreeItem
  ): Promise<void> {
    const api = this.getApiForStack(stackOrBranch.stack);
    if (!api) {
      window.showErrorMessage("No API available for this stack's repository");
      return;
    }

    const branchesOrderedByCommitterDate =
      await api.getBranchesByCommitterDate();

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
          title: `Creating new branch '${branchName}' in stack '${stackOrBranch.stack.name}'`,
          cancellable: false,
        },
        async () => {
          try {
            await api.newBranch(
              stackOrBranch.stack.name,
              branchName!,
              stackOrBranch.type === "stack"
                ? stackOrBranch.stack.sourceBranch.name
                : stackOrBranch.branch.name
            );
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
          title: `Adding branch '${branchName}' to stack '${stackOrBranch.stack.name}'`,
          cancellable: false,
        },
        async () => {
          try {
            await api.addBranch(
              stackOrBranch.stack.name,
              branchName!,
              stackOrBranch.type === "stack"
                ? stackOrBranch.stack.sourceBranch.name
                : stackOrBranch.branch.name
            );
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
    const api = this.getApiForStack(stack.stack);
    if (!api) {
      window.showErrorMessage("No API available for this stack's repository");
      return;
    }

    const updateStrategy = await api.getUpdateStrategyFromConfig();

    const separator: QuickPickItem = {
      label: "",
      kind: QuickPickItemKind.Separator,
    };

    const confirmQuickPickItems: QuickPickItem[] = [];
    const syncStackWithMerge: QuickPickItem = {
      label: "Sync Stack (Merge)",
      detail:
        "Will fetch the latest changes from the remote, update the stack by merging branches and push commits back to the remote",
    };
    const syncStackWithRebase: QuickPickItem = {
      label: "Sync Stack (Rebase)",
      detail:
        "Will fetch the latest changes from the remote, update the stack by rebasing branches and push commits back to the remote",
    };

    if (updateStrategy === undefined) {
      confirmQuickPickItems.push(syncStackWithMerge, syncStackWithRebase);
    } else {
      confirmQuickPickItems.push(
        ...(updateStrategy === "merge"
          ? [syncStackWithMerge, syncStackWithRebase]
          : [syncStackWithRebase, syncStackWithMerge])
      );
    }

    const cancel: QuickPickItem = {
      label: "Cancel",
    };

    const confirm = await window.showQuickPick(
      [...confirmQuickPickItems, separator, cancel],
      {
        placeHolder: `Are you sure you want to sync stack '${stack.stack.name}'?`,
        title: "Confirm Sync Stack",
      }
    );

    if (
      confirm === undefined ||
      confirmQuickPickItems.indexOf(confirm) === -1
    ) {
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
          if (confirm === syncStackWithMerge) {
            await api.sync(stack.stack.name, "merge");
          } else if (confirm === syncStackWithRebase) {
            await api.sync(stack.stack.name, "rebase");
          }

          this.refresh();
        } catch (err) {
          window.showErrorMessage(`Error syncing changes: ${err}`);
        }
      }
    );
  }

  async update(stack: StackTreeItem): Promise<void> {
    const api = this.getApiForStack(stack.stack);
    if (!api) {
      window.showErrorMessage("No API available for this stack's repository");
      return;
    }

    const updateStrategy = await api.getUpdateStrategyFromConfig();

    const confirmQuickPickItems: QuickPickItem[] = [];
    const updateStackWithMerge: QuickPickItem = {
      label: "Update Stack (Merge)",
      detail:
        "Will update branches in the stack locally by merging branches, does not pull changes from or push changes to the remote",
    };
    const updateStackWithRebase: QuickPickItem = {
      label: "Update Stack (Rebase)",
      detail:
        "Will update branches in the stack locally by rebasing branches, does not pull changes from or push changes to the remote",
    };

    if (updateStrategy === undefined) {
      confirmQuickPickItems.push(updateStackWithMerge, updateStackWithRebase);
    } else {
      confirmQuickPickItems.push(
        ...(updateStrategy === "merge"
          ? [updateStackWithMerge, updateStackWithRebase]
          : [updateStackWithRebase, updateStackWithMerge])
      );
    }

    const separator: QuickPickItem = {
      label: "",
      kind: QuickPickItemKind.Separator,
    };

    const cancel: QuickPickItem = {
      label: "Cancel",
    };

    const confirm = await window.showQuickPick(
      [...confirmQuickPickItems, separator, cancel],
      {
        placeHolder: `Are you sure you want to update stack '${stack.stack.name}'?`,
        title: "Confirm Update Stack",
      }
    );

    if (
      confirm === undefined ||
      confirmQuickPickItems.indexOf(confirm) === -1
    ) {
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
          if (confirm === updateStackWithMerge) {
            await api.update(stack.stack.name, "merge");
          } else if (confirm === updateStackWithRebase) {
            await api.update(stack.stack.name, "rebase");
          }

          this.refresh();
        } catch (err) {
          window.showErrorMessage(`Error updating changes: ${err}`);
          throw err;
        }
      }
    );
  }

  async pull(stack: StackTreeItem): Promise<void> {
    const api = this.getApiForStack(stack.stack);
    if (!api) {
      window.showErrorMessage("No API available for this stack's repository");
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
          await api.pull(stack.stack.name);
          this.refresh();
        } catch (err) {
          window.showErrorMessage(`Error pulling changes: ${err}`);
        }
      }
    );
  }

  async push(stack: StackTreeItem, forceWithLease: boolean): Promise<void> {
    const api = this.getApiForStack(stack.stack);
    if (!api) {
      window.showErrorMessage("No API available for this stack's repository");
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
          await api.push(stack.stack.name, forceWithLease);
          this.refresh();
        } catch (err) {
          window.showErrorMessage(`Error pushing changes: ${err}`);
        }
      }
    );
  }

  async delete(stack: StackTreeItem): Promise<void> {
    const api = this.getApiForStack(stack.stack);
    if (!api) {
      window.showErrorMessage("No API available for this stack's repository");
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
          await api.delete(stack.stack.name);
          this.refresh();
        } catch (err) {
          window.showErrorMessage(`Error deleting stack: ${err}`);
          throw err;
        }
      }
    );
  }

  async cleanup(stack: StackTreeItem): Promise<void> {
    const api = this.getApiForStack(stack.stack);
    if (!api) {
      window.showErrorMessage("No API available for this stack's repository");
      return;
    }

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
          await api.cleanup(stack.stack.name);
          this.refresh();
        } catch (err) {
          window.showErrorMessage(`Error cleaning up stack: ${err}`);
          throw err;
        }
      }
    );
  }

  async switchTo(branch: string): Promise<void> {
    const api = this.getDefaultApi();
    if (!api) {
      window.showErrorMessage("No API available for switching branches");
      return;
    }

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Switching to branch '${branch}'`,
        cancellable: false,
      },
      async () => {
        try {
          await api.switchToBranch(branch);
        } catch (err) {
          window.showErrorMessage(`Error switching to branch: ${err}`);
        }
      }
    );
  }

  async removeBranchFromStack(branch: BranchTreeItem): Promise<void> {
    const api = this.getApiForStack(branch.stack);
    if (!api) {
      window.showErrorMessage("No API available for this stack's repository");
      return;
    }

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
          await api.removeBranch(branch.stack.name, branch.branch.name);
          this.refresh();
        } catch (err) {
          window.showErrorMessage(`Error switching to branch: ${err}`);
        }
      }
    );
  }

  openPullRequest(pullRequest: PullRequestTreeItem): void {
    commands.executeCommand("vscode.open", pullRequest.pullRequest.url);
  }

  getTreeItem(element: StackTreeData): TreeItem {
    if (element.type === "repository") {
      const repositoryTreeItem = new TreeItem(
        element.repositoryName,
        TreeItemCollapsibleState.Collapsed
      );
      repositoryTreeItem.id = `repo-${element.repositoryPath}`;
      repositoryTreeItem.iconPath = new ThemeIcon("repo");

      // Show stack count if available, otherwise show loading or nothing
      const stackCount = this.repositoryStackCounts.get(element.repositoryPath);
      if (stackCount !== undefined) {
        repositoryTreeItem.description = `${stackCount} ${pluralize(
          "stack",
          stackCount
        )}`;
      } else {
        repositoryTreeItem.description = "Loading...";
      }

      repositoryTreeItem.contextValue = "repository";

      return repositoryTreeItem;
    } else if (element.type === "stack") {
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
        canCompareBranchToParent(element.branch) ||
        element.branch.children.length
          ? TreeItemCollapsibleState.Collapsed
          : TreeItemCollapsibleState.None
      );
      branchTreeItem.iconPath = new ThemeIcon(
        "git-branch",
        element.branch.exists
          ? undefined
          : new ThemeColor("descriptionForeground")
      );
      branchTreeItem.contextValue = `branch.${
        element.branch.exists ? "exists" : "deleted"
      }`;

      // Set the resource URI to apply decorations
      branchTreeItem.resourceUri = Uri.parse(
        `stack:${element.branch.name}${element.branch.exists ? "" : ".deleted"}`
      );

      if (!element.branch.exists) {
        branchTreeItem.tooltip = "This branch has been deleted";
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
    } else if (element.type === "childBranches") {
      const childBranchesTreeItem = new TreeItem(
        `${element.children.length} ${pluralize(
          "branch",
          element.children.length
        )}`,
        TreeItemCollapsibleState.Collapsed
      );
      childBranchesTreeItem.iconPath = new ThemeIcon("list-tree");
      childBranchesTreeItem.contextValue = "childBranches";
      const activeChildBranchCount = element.children.filter(
        (branch) => branch.exists && branch.remoteTrackingBranch?.exists
      ).length;

      if (activeChildBranchCount < element.children.length) {
        childBranchesTreeItem.description = `${activeChildBranchCount} active`;
      }
      return childBranchesTreeItem;
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
      // Root level - show repositories if multiple, otherwise show stacks directly
      const repositoryPaths = Array.from(this.apis.keys());

      if (repositoryPaths.length === 0) {
        return [];
      }

      if (repositoryPaths.length === 1) {
        // Single repository - show stacks directly
        const cache = this.stackCaches.get(repositoryPaths[0])!;
        const stacks = await cache.getStacks();
        return stacks.map((stack) => ({
          type: "stack",
          stack,
        }));
      } else {
        // Multiple repositories - show repository sections without loading stacks
        const repositories: RepositoryTreeItem[] = [];

        for (const repositoryPath of repositoryPaths) {
          const repositoryName =
            repositoryPath.split("\\").pop() ||
            repositoryPath.split("/").pop() ||
            repositoryPath;

          repositories.push({
            type: "repository",
            repositoryName,
            repositoryPath,
            // Don't load stacks here - they'll be loaded when the repository is expanded
          });

          // Trigger async loading of stack count if not already loaded or loading
          if (
            !this.repositoryStackCounts.has(repositoryPath) &&
            !this.loadingStackCounts.has(repositoryPath)
          ) {
            this.loadRepositoryStackCount(repositoryPath);
          }
        }

        return repositories;
      }
    } else {
      if (element.type === "repository") {
        // Load stacks for this repository when it's expanded
        const cache = this.stackCaches.get(element.repositoryPath)!;
        const stacks = await cache.getStacks();

        return stacks.map((stack) => ({
          type: "stack",
          stack: { ...stack, repositoryName: element.repositoryName },
        }));
      } else if (element.type === "stack") {
        const stackDetails = element.stack;

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
        const treeItems: StackTreeData[] = [];

        if (canCompareBranchToParent(element.branch)) {
          const aheadOfParent = element.branch.parent?.ahead ?? 0;
          const behindParent = element.branch.parent.behind ?? 0;

          const branchParentStatusTreeItem: ParentStatusTreeItem = {
            type: "branchParentStatus",
            parentBranchName: element.branch.parent.name,
            aheadOfParent: aheadOfParent,
            behindParent: behindParent,
          };

          treeItems.push(branchParentStatusTreeItem);

          if (element.branch.pullRequest) {
            treeItems.push({
              type: "pullRequest",
              pullRequest: element.branch.pullRequest,
            });
          }
        }

        if (element.branch.children.length > 0) {
          // treeItems.push({
          //   type: "childBranches",
          //   stack: element.stack,
          //   children: element.branch.children,
          // });
          const childBranches: BranchTreeItem[] = element.branch.children.map(
            (childBranch) => {
              return {
                type: "branch",
                stack: element.stack,
                branch: childBranch,
              };
            }
          );
          treeItems.push(...childBranches);
        }

        return treeItems;
      } else if (element.type === "childBranches") {
        return element.children.map((childBranch) => {
          return {
            type: "branch",
            stack: element.stack,
            branch: childBranch,
          };
        });
      }
    }

    return [];
  }
}
