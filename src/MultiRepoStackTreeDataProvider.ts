import {
  Event,
  EventEmitter,
  QuickPickItem,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  window,
  LogOutputChannel,
} from "vscode";
import {
  StackTreeDataProvider,
  StackTreeData,
  StackTreeItem,
  BranchTreeItem,
  PullRequestTreeItem,
} from "./StackTreeDataProvider";

export type RepositoryRootTreeItem = {
  type: "repositoryRoot";
  name: string; // repository folder name
  provider: StackTreeDataProvider;
  stackCount?: number;
};

export type AggregatedTreeItem = StackTreeData | RepositoryRootTreeItem;

// We augment returned stack/branch/pr items with a hidden reference to their provider for routing commands.
// Note: we dynamically augment tree items with a __provider field (typed as any) for routing.

export class MultiRepoStackTreeDataProvider
  implements TreeDataProvider<AggregatedTreeItem>
{
  private _onDidChangeTreeData: EventEmitter<
    AggregatedTreeItem | undefined | void
  > = new EventEmitter();
  readonly onDidChangeTreeData: Event<AggregatedTreeItem | undefined | void> =
    this._onDidChangeTreeData.event;

  constructor(
    private readonly providers: StackTreeDataProvider[],
    private readonly logger: LogOutputChannel
  ) {
    // Bubble child provider refresh events
    for (const p of providers) {
      p.onDidChangeTreeData(() => this._onDidChangeTreeData.fire());
    }
  }

  private isMultiRepo(): boolean {
    return this.providers.length > 1;
  }

  refresh(): void {
    for (const p of this.providers) {
      p.refresh();
    }
    this._onDidChangeTreeData.fire();
  }

  // Command routing helpers -------------------------------------------------
  private providerFromElement(element?: StackTreeData): StackTreeDataProvider {
    if (!element) {
      return this.providers[0];
    }
    return (element as any).__provider ?? this.providers[0];
  }

  async newStack(): Promise<void> {
    if (this.providers.length === 0) {
      return;
    }
    let provider: StackTreeDataProvider;
    if (this.isMultiRepo()) {
      const picks: QuickPickItem[] = this.providers.map((p) => ({
        label: (p as any).repositoryName ?? "Repository",
        description: (p as any).repositoryPath,
      }));
      const selection = await window.showQuickPick(picks, {
        placeHolder: "Select repository for new stack",
      });
      if (!selection) {
        return;
      }
      provider = this.providers[picks.indexOf(selection)];
    } else {
      provider = this.providers[0];
    }
    await provider.newStack();
  }

  async newBranch(element: StackTreeItem | BranchTreeItem) {
    const provider = this.providerFromElement(element);
    await provider.newBranch(element as any);
  }
  async sync(element: StackTreeItem) {
    await this.providerFromElement(element).sync(element as any);
  }
  async update(element: StackTreeItem) {
    await this.providerFromElement(element).update(element as any);
  }
  async pull(element: StackTreeItem) {
    await this.providerFromElement(element).pull(element as any);
  }
  async push(element: StackTreeItem, forceWithLease: boolean) {
    await this.providerFromElement(element).push(
      element as any,
      forceWithLease
    );
  }
  async delete(element: StackTreeItem) {
    await this.providerFromElement(element).delete(element as any);
  }
  async cleanup(element: StackTreeItem) {
    await this.providerFromElement(element).cleanup(element as any);
  }
  async switchTo(branchOrStack: StackTreeItem | BranchTreeItem) {
    const provider = this.providerFromElement(branchOrStack as any);
    if ((branchOrStack as any).type === "stack") {
      await provider.switchTo(
        (branchOrStack as StackTreeItem).stack.sourceBranch.name
      );
    } else if (
      (branchOrStack as BranchTreeItem).type === "branch" &&
      (branchOrStack as BranchTreeItem).branch.exists
    ) {
      await provider.switchTo((branchOrStack as BranchTreeItem).branch.name);
    }
  }
  async removeBranchFromStack(branch: BranchTreeItem) {
    await this.providerFromElement(branch).removeBranchFromStack(branch as any);
  }
  openPullRequest(pr: PullRequestTreeItem) {
    this.providerFromElement(pr).openPullRequest(pr as any);
  }

  // TreeDataProvider implementation -----------------------------------------
  getTreeItem(element: AggregatedTreeItem): TreeItem {
    if (element.type === "repositoryRoot") {
      const item = new TreeItem(
        element.name,
        TreeItemCollapsibleState.Collapsed
      );
      item.iconPath = new ThemeIcon("repo");
      item.contextValue = "repositoryRoot";
      const count = element.stackCount ?? 0;
      item.description = `${count} stack${count === 1 ? "" : "s"}`;
      item.tooltip = `${count} stack${count === 1 ? "" : "s"}`;
      return item;
    }
    return this.providerFromElement(element).getTreeItem(element as any);
  }

  async getChildren(
    element?: AggregatedTreeItem
  ): Promise<AggregatedTreeItem[]> {
    if (!element) {
      if (!this.isMultiRepo()) {
        // Single repo -> passthrough
        const provider = this.providers[0];
        const children = (await provider.getChildren()) as StackTreeData[];
        children.forEach((c) => ((c as any).__provider = provider));
        return children;
      }
      // Eagerly load counts for each repository
      const results = await Promise.all(
        this.providers.map(async (p) => {
          const repoName = (p as any).repositoryName ?? "Repository";
          try {
            const api: any = (p as any).getApi
              ? (p as any).getApi()
              : undefined;
            const summaries = api?.getStackSummaries
              ? await api.getStackSummaries()
              : [];
            return { provider: p, repoName, count: summaries.length };
          } catch (err: any) {
            this.logger.error(
              `Failed to load stack summaries for ${repoName}: ${err}`
            );
            return { provider: p, repoName, count: 0 };
          }
        })
      );
      return results.map(
        (r) =>
          ({
            type: "repositoryRoot",
            name: r.repoName,
            provider: r.provider,
            stackCount: r.count,
          } as RepositoryRootTreeItem)
      );
    }

    if (element.type === "repositoryRoot") {
      const children =
        (await element.provider.getChildren()) as StackTreeData[];
      children.forEach((c) => ((c as any).__provider = element.provider));
      return children;
    }

    // Delegate deeper levels to child provider
    const provider = this.providerFromElement(element as any);
    const grandchildren = (await provider.getChildren(
      element as any
    )) as StackTreeData[];
    grandchildren.forEach((c) => ((c as any).__provider = provider));
    return grandchildren;
  }
}
