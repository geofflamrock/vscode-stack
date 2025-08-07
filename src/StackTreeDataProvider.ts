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
import { Repository } from "./typings/git";
import { IStackApi } from "./stack";
import { StackCache } from "./stack/stackCache";

export type RepositoryTreeItem = {
  type: "repository";
  repository: Repository;
  api: IStackApi;
};

export type StackTreeItem = {
  type: "stack";
  stack: Stack;
  api: IStackApi;
};

export type BranchTreeItem = {
  type: "branch";
  stack: Stack;
  branch: StackBranch;
  api: IStackApi;
};

export type ChildBranchesTreeItem = {
  type: "childBranches";
  stack: Stack;
  children: StackBranch[];
  api: IStackApi;
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
  private repositories: Repository[] = [];
  private logger?: any;

  constructor(repositories: Repository[], private apis: Map<Repository, IStackApi>, logger?: any) {
    this.repositories = repositories;
    this.logger = logger;
    this.logger?.info(`StackTreeDataProvider constructor: ${repositories.length} repositories`);
    for (const [repo, api] of apis) {
      const repoPath = repo.rootUri.fsPath;
      this.logger?.info(`Creating stackCache for: ${repoPath}`);
      this.stackCaches.set(repoPath, new StackCache(api, logger));
    }
    this.logger?.info(`StackCaches created: ${this.stackCaches.size}`);
  }

  private _onDidChangeTreeData: EventEmitter<
    StackTreeData | undefined | null | void
  > = new EventEmitter<StackTreeData | undefined | null | void>();
  readonly onDidChangeTreeData: Event<StackTreeData | undefined | null | void> =
    this._onDidChangeTreeData.event;

  refresh(): void {
    for (const cache of this.stackCaches.values()) {
      cache.clearCache();
    }
    this._onDidChangeTreeData.fire();
  }

  private getRepositoryName(repository: Repository): string {
    const rootPath = repository.rootUri.fsPath;
    const pathParts = rootPath.split(/[\\/]/);
    return pathParts[pathParts.length - 1] || 'Repository';
  }

  private getDefaultApi(): IStackApi | undefined {
    if (this.repositories.length === 1) {
      return this.apis.get(this.repositories[0]);
    }
    return undefined;
  }

  updateRepositories(repositories: Repository[], apis: Map<Repository, IStackApi>, logger?: any): void {
    this.repositories = repositories;
    this.apis = apis;
    this.logger = logger;
    
    this.logger?.info(`updateRepositories called with ${repositories.length} repositories`);
    
    // Clear old caches
    this.stackCaches.clear();
    
    // Create new caches for all repositories
    for (const [repo, api] of apis) {
      const repoPath = repo.rootUri.fsPath;
      this.logger?.info(`Updating stackCache for: ${repoPath}`);
      this.stackCaches.set(repoPath, new StackCache(api, logger));
    }
    
    this.logger?.info(`Updated stackCaches: ${this.stackCaches.size}`);
    
    // Refresh the tree
    this.refresh();
  }

  async newStack(api?: IStackApi): Promise<void> {
    let stackApi = api || this.getDefaultApi();
    
    if (!stackApi && this.repositories.length > 1) {
      // Multiple repositories - let user select which one
      const repoItems = this.repositories.map(repo => ({
        label: this.getRepositoryName(repo),
        detail: repo.rootUri.fsPath,
        repoPath: repo.rootUri.fsPath
      }));
      
      const selectedRepo = await window.showQuickPick(repoItems, {
        placeHolder: 'Select repository for new stack'
      });
      
      if (!selectedRepo) {
        this.logger?.info('User cancelled repository selection');
        return;
      }
      
      this.logger?.info(`User selected repository: ${selectedRepo.repoPath}`);
      this.logger?.info(`Available APIs: ${Array.from(this.apis.keys()).map(r => r.rootUri.fsPath).join(', ')}`);
      
      // Find the API by matching repository path
      for (const [repo, api] of this.apis.entries()) {
        if (repo.rootUri.fsPath === selectedRepo.repoPath) {
          this.logger?.info(`Found API for selected repo: ${repo.rootUri.fsPath}`);
          stackApi = api;
          break;
        }
      }
    }
    
    if (!stackApi) {
      this.logger?.error('No stackApi found after selection process');
      this.logger?.error(`Repositories length: ${this.repositories.length}`);
      this.logger?.error(`APIs size: ${this.apis.size}`);
      window.showErrorMessage('No repository selected');
      return;
    }
    
    this.logger?.info('Successfully found stackApi, proceeding with stack creation');
    
    const stackName = await window.showInputBox({ prompt: "Enter stack name" });

    if (!stackName) {
      return;
    }

    const branchesOrderedByCommitterDate =
      await stackApi.getBranchesByCommitterDate();

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
          await stackApi.newStack(stackName, sourceBranch, branchName);
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
    const stackApi = stackOrBranch.api;
    const branchesOrderedByCommitterDate =
      await stackApi.getBranchesByCommitterDate();

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
            await stackApi.newBranch(
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
            await stackApi.addBranch(
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
    const stackApi = stack.api;
    const updateStrategy = await stackApi.getUpdateStrategyFromConfig();

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
            await stackApi.sync(stack.stack.name, "merge");
          } else if (confirm === syncStackWithRebase) {
            await stackApi.sync(stack.stack.name, "rebase");
          }

          this.refresh();
        } catch (err) {
          window.showErrorMessage(`Error syncing changes: ${err}`);
        }
      }
    );
  }

  async update(stack: StackTreeItem): Promise<void> {
    const stackApi = stack.api;
    const updateStrategy = await stackApi.getUpdateStrategyFromConfig();

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
            await stackApi.update(stack.stack.name, "merge");
          } else if (confirm === updateStackWithRebase) {
            await stackApi.update(stack.stack.name, "rebase");
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
    const stackApi = stack.api;
    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Pulling changes for stack '${stack.stack.name}'`,
        cancellable: false,
      },
      async () => {
        try {
          await stackApi.pull(stack.stack.name);
          this.refresh();
        } catch (err) {
          window.showErrorMessage(`Error pulling changes: ${err}`);
        }
      }
    );
  }

  async push(stack: StackTreeItem, forceWithLease: boolean): Promise<void> {
    const stackApi = stack.api;
    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Pushing changes for stack '${stack.stack.name}'`,
        cancellable: false,
      },
      async () => {
        try {
          await stackApi.push(stack.stack.name, forceWithLease);
          this.refresh();
        } catch (err) {
          window.showErrorMessage(`Error pushing changes: ${err}`);
        }
      }
    );
  }

  async delete(stack: StackTreeItem): Promise<void> {
    const stackApi = stack.api;
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
          await stackApi.delete(stack.stack.name);
          this.refresh();
        } catch (err) {
          window.showErrorMessage(`Error deleting stack: ${err}`);
          throw err;
        }
      }
    );
  }

  async cleanup(stack: StackTreeItem): Promise<void> {
    const stackApi = stack.api;
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
          await stackApi.cleanup(stack.stack.name);
          this.refresh();
        } catch (err) {
          window.showErrorMessage(`Error cleaning up stack: ${err}`);
          throw err;
        }
      }
    );
  }

  async switchTo(branch: string, api?: IStackApi): Promise<void> {
    const stackApi = api || this.getDefaultApi();
    if (!stackApi) {
      window.showErrorMessage('No repository selected');
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
          await stackApi.switchToBranch(branch);
        } catch (err) {
          window.showErrorMessage(`Error switching to branch: ${err}`);
        }
      }
    );
  }

  async removeBranchFromStack(branch: BranchTreeItem): Promise<void> {
    const stackApi = branch.api;
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
          await stackApi.removeBranch(branch.stack.name, branch.branch.name);
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
        this.getRepositoryName(element.repository),
        TreeItemCollapsibleState.Expanded
      );
      repositoryTreeItem.id = element.repository.rootUri.fsPath;
      repositoryTreeItem.iconPath = new ThemeIcon("repo");
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
    this.logger?.info(`getChildren called, element: ${element?.type || 'root'}`);
    this.logger?.info(`Total repositories: ${this.repositories.length}`);
    if (!element) {
      if (this.repositories.length === 1) {
        // Single repository - show stacks directly
        const repo = this.repositories[0];
        const repoPath = repo.rootUri.fsPath;
        const stackCache = this.stackCaches.get(repoPath);
        const api = this.apis.get(repo);
        
        this.logger?.info(`Single repo mode: ${repoPath}`);
        this.logger?.info(`StackCache available: ${!!stackCache}`);
        this.logger?.info(`API available: ${!!api}`);
        
        if (!stackCache || !api) {
          this.logger?.warn('Missing stackCache or api, returning empty array');
          return [];
        }
        
        this.logger?.info('Getting stacks for single repository');
        const stacks = await stackCache.getStacks();
        this.logger?.info(`Single repository has ${stacks.length} stacks`);

        return stacks.map((stack) => {
          return {
            type: "stack",
            stack,
            api,
          };
        });
      } else {
        // Multiple repositories - show repository sections
        this.logger?.info('Multiple repositories mode, creating repository items');
        return this.repositories.map((repository) => {
          const api = this.apis.get(repository)!;
          this.logger?.info(`Creating repository item for: ${repository.rootUri.fsPath}`);
          return {
            type: "repository",
            repository,
            api,
          };
        });
      }
    } else {
      if (element.type === "repository") {
        // Show stacks for this repository
        const repoPath = element.repository.rootUri.fsPath;
        this.logger?.info(`Looking for stackCache for repository: ${repoPath}`);
        this.logger?.info(`Available stackCaches: ${Array.from(this.stackCaches.keys()).join(', ')}`);
        const stackCache = this.stackCaches.get(repoPath);
        
        if (!stackCache) {
          this.logger?.warn(`No stackCache found for repository: ${repoPath}`);
          return [];
        }
        
        this.logger?.info(`Getting stacks for repository: ${element.repository.rootUri.fsPath}`);
        const stacks = await stackCache.getStacks();
        this.logger?.info(`Repository ${element.repository.rootUri.fsPath} has ${stacks.length} stacks`);
        const api = element.api;

        return stacks.map((stack) => {
          return {
            type: "stack",
            stack,
            api,
          };
        });
      } else if (element.type === "stack") {
        const stackDetails = element.stack;

        const branches: BranchTreeItem[] = stackDetails.branches.map(
          (branch) => {
            return {
              type: "branch",
              stack: element.stack,
              branch,
              api: element.api,
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
                api: element.api,
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
            api: element.api,
          };
        });
      }
    }

    return [];
  }
}
