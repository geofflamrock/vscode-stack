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

export interface RepositoryProviderMetadata {
    provider: StackTreeDataProvider;
    repositoryName: string;
    repositoryPath: string;
}

export type RepositoryRootTreeItem = {
    type: "repositoryRoot";
    name: string; // repository folder name
    provider: StackTreeDataProvider;
    stackCount?: number;
};

export type AggregatedTreeItem = StackTreeData | RepositoryRootTreeItem;

export class MultiRepoStackTreeDataProvider implements TreeDataProvider<AggregatedTreeItem> {
    private _onDidChangeTreeData: EventEmitter<AggregatedTreeItem | undefined | void> =
        new EventEmitter();
    readonly onDidChangeTreeData: Event<AggregatedTreeItem | undefined | void> =
        this._onDidChangeTreeData.event;

    private readonly providerMap = new WeakMap<StackTreeData, StackTreeDataProvider>();

    private repositories: RepositoryProviderMetadata[];
    private childDisposers: (() => void)[] = [];

    constructor(
        repositories: RepositoryProviderMetadata[],
        private readonly logger: LogOutputChannel,
    ) {
        this.repositories = repositories;
        this.registerChildListeners();
    }

    setRepositories(repositories: RepositoryProviderMetadata[]): void {
        // dispose old listeners
        for (const dispose of this.childDisposers) {
            try {
                dispose();
            } catch {
                /* ignore */
            }
        }
        this.childDisposers = [];
        this.repositories = repositories;
        this.registerChildListeners();
        this._onDidChangeTreeData.fire();
    }

    addRepository(metadata: RepositoryProviderMetadata): void {
        this.repositories.push(metadata);
        // Listen to its changes
        const disposable = metadata.provider.onDidChangeTreeData(() =>
            this._onDidChangeTreeData.fire(),
        );
        this.childDisposers.push(() => disposable.dispose());
        this._onDidChangeTreeData.fire();
    }

    removeRepository(repositoryPath: string): void {
        const index = this.repositories.findIndex((r) => r.repositoryPath === repositoryPath);
        if (index === -1) {
            return;
        }
        // Remove and rebuild listeners (simpler than mapping disposer per repo)
        const removed = this.repositories.splice(index, 1);
        if (removed.length) {
            for (const dispose of this.childDisposers) {
                try {
                    dispose();
                } catch {
                    /* ignore */
                }
            }
            this.childDisposers = [];
            this.registerChildListeners();
            this._onDidChangeTreeData.fire();
        }
    }

    private registerChildListeners(): void {
        for (const { provider } of this.repositories) {
            const disposable = provider.onDidChangeTreeData(() => this._onDidChangeTreeData.fire());
            this.childDisposers.push(() => disposable.dispose());
        }
    }

    private isMultiRepo(): boolean {
        return this.repositories.length > 1;
    }

    refresh(): void {
        for (const { provider } of this.repositories) {
            provider.refresh();
        }
        this._onDidChangeTreeData.fire();
    }

    // Command routing helpers -------------------------------------------------
    private providerFromElement(element?: StackTreeData): StackTreeDataProvider {
        if (!element) {
            if (this.repositories.length === 0) {
                throw new Error("No repositories available");
            }
            return this.repositories[0].provider;
        }
        return this.providerMap.get(element) ?? this.repositories[0].provider;
    }

    async newStack(): Promise<void> {
        if (this.repositories.length === 0) {
            return;
        }
        let provider: StackTreeDataProvider;
        if (this.isMultiRepo()) {
            const picks: QuickPickItem[] = this.repositories.map((r) => ({
                label: r.repositoryName || "Repository",
                description: r.repositoryPath,
            }));
            const selection = await window.showQuickPick(picks, {
                placeHolder: "Select repository for new stack",
            });
            if (!selection) {
                return;
            }
            provider = this.repositories[picks.indexOf(selection)].provider;
        } else {
            provider = this.repositories[0].provider;
        }
        await provider.newStack();
    }

    async newBranch(element: StackTreeItem | BranchTreeItem) {
        const provider = this.providerFromElement(element);
        await provider.newBranch(element);
    }
    async sync(element: StackTreeItem) {
        await this.providerFromElement(element).sync(element);
    }
    async update(element: StackTreeItem) {
        await this.providerFromElement(element).update(element);
    }
    async pull(element: StackTreeItem) {
        await this.providerFromElement(element).pull(element);
    }
    async push(element: StackTreeItem, forceWithLease: boolean) {
        await this.providerFromElement(element).push(element, forceWithLease);
    }
    async delete(element: StackTreeItem) {
        await this.providerFromElement(element).delete(element);
    }
    async cleanup(element: StackTreeItem) {
        await this.providerFromElement(element).cleanup(element);
    }
    async switchTo(branchOrStack: StackTreeItem | BranchTreeItem) {
        const provider = this.providerFromElement(
            branchOrStack.type === "stack" ? branchOrStack : undefined,
        );
        if (branchOrStack.type === "stack") {
            await provider.switchTo(branchOrStack.stack.sourceBranch.name);
        } else if (branchOrStack.type === "branch" && branchOrStack.branch.exists) {
            await this.providerFromElement(branchOrStack).switchTo(branchOrStack.branch.name);
        }
    }
    async removeBranchFromStack(branch: BranchTreeItem) {
        await this.providerFromElement(branch).removeBranchFromStack(branch);
    }
    openPullRequest(pr: PullRequestTreeItem) {
        this.providerFromElement(pr).openPullRequest(pr);
    }

    // TreeDataProvider implementation -----------------------------------------
    getTreeItem(element: AggregatedTreeItem): TreeItem {
        if (element.type === "repositoryRoot") {
            const item = new TreeItem(element.name, TreeItemCollapsibleState.Collapsed);
            item.iconPath = new ThemeIcon("repo");
            item.contextValue = "repositoryRoot";
            const count = element.stackCount ?? 0;
            item.description = `${count} stack${count === 1 ? "" : "s"}`;
            item.tooltip = `${count} stack${count === 1 ? "" : "s"}`;
            return item;
        }
        return this.providerFromElement(element).getTreeItem(element);
    }

    async getChildren(element?: AggregatedTreeItem): Promise<AggregatedTreeItem[]> {
        if (!element) {
            if (this.repositories.length === 0) {
                return [];
            }
            if (!this.isMultiRepo()) {
                const provider = this.repositories[0].provider;
                const children = await provider.getChildren();
                this.recordProvider(children, provider);
                return children;
            }
            const roots: RepositoryRootTreeItem[] = [];
            for (const { provider, repositoryName, repositoryPath } of this.repositories) {
                try {
                    const summaries = await provider.getApi().getStackSummaries();
                    roots.push({
                        type: "repositoryRoot",
                        name: repositoryName || repositoryPath,
                        provider,
                        stackCount: summaries.length,
                    });
                } catch (err) {
                    this.logger.error(
                        `Failed to load stack summaries for ${repositoryName}: ${err}`,
                    );
                    roots.push({
                        type: "repositoryRoot",
                        name: repositoryName || repositoryPath,
                        provider,
                        stackCount: 0,
                    });
                }
            }
            return roots;
        }

        if (element.type === "repositoryRoot") {
            const children = await element.provider.getChildren();
            this.recordProvider(children, element.provider);
            return children;
        }

        const provider = this.providerFromElement(element);
        const grandchildren = await provider.getChildren(element);
        this.recordProvider(grandchildren, provider);
        return grandchildren;
    }

    private recordProvider(
        items: StackTreeData[] | undefined,
        provider: StackTreeDataProvider,
    ): void {
        if (!items) {
            return;
        }
        for (const item of items) {
            this.providerMap.set(item, provider);
        }
    }
}
