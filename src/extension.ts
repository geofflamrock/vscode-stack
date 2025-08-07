// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import {
  ExtensionContext,
  workspace,
  window,
  Disposable,
  commands,
  extensions,
} from "vscode";
import {
  BranchTreeItem,
  PullRequestTreeItem,
  RepositoryTreeItem,
  StackTreeDataProvider,
  StackTreeItem,
} from "./StackTreeDataProvider";
import { GitExtension } from "./typings/git";
import { StackApi } from "./stack";
import * as vscode from "vscode";

class BranchFileDecorationProvider implements vscode.FileDecorationProvider {
  onDidChangeFileDecorations?: vscode.Event<vscode.Uri | vscode.Uri[]>;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.path.endsWith(".deleted")) {
      return {
        color: new vscode.ThemeColor("descriptionForeground"),
      };
    }
    return undefined;
  }
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
  const disposables: Disposable[] = [];

  const logger = window.createOutputChannel("Stack", { log: true });
  disposables.push(logger);

  let gitExtension = extensions.getExtension<GitExtension>("vscode.git");
  let stackDataProvider: StackTreeDataProvider | undefined;

  const initialize = () => {
    gitExtension!.activate().then((extension) => {
      const onDidChangeGitExtensionEnablement = (enabled: boolean) => {
        if (enabled) {
          const gitAPI = extension.getAPI(1);
          if (!gitAPI.repositories.length) {
            logger.warn("No git repositories found in the workspace.");
            return;
          }

          // Create a single StackTreeDataProvider that manages multiple repositories
          stackDataProvider = new StackTreeDataProvider();

          // Add all repositories to the data provider
          gitAPI.repositories.forEach((repo) => {
            const repoPath = repo.rootUri.fsPath;
            const repoName =
              repoPath.split("\\").pop() ||
              repoPath.split("/").pop() ||
              repoPath;
            const stackApi = new StackApi(repo, logger);
            stackDataProvider!.addRepository(repoPath, repoName, stackApi);
          });

          disposables.push(
            window.registerTreeDataProvider("stack", stackDataProvider)
          );

          // Listen for repository changes
          const onDidChangeRepositories = () => {
            if (!stackDataProvider) {
              return;
            }

            // Add new repositories
            gitAPI.repositories.forEach((repo) => {
              const repoPath = repo.rootUri.fsPath;
              if (!stackDataProvider!.getApiForRepository(repoPath)) {
                const repoName =
                  repoPath.split("\\").pop() ||
                  repoPath.split("/").pop() ||
                  repoPath;
                const stackApi = new StackApi(repo, logger);
                stackDataProvider!.addRepository(repoPath, repoName, stackApi);
                stackDataProvider!.refresh();
              }
            });
          };

          // Note: Git API doesn't expose onDidChangeRepositories, so we'll handle this manually
          // when workspace folders change or through commands
          gitAPI.onDidOpenRepository(onDidChangeRepositories);
          gitAPI.onDidCloseRepository(onDidChangeRepositories);

          registerCommands(stackDataProvider);
        } else {
          Disposable.from(...disposables).dispose();
        }
      };

      disposables.push(
        extension.onDidChangeEnablement(onDidChangeGitExtensionEnablement)
      );
      onDidChangeGitExtensionEnablement(extension.enabled);
    });
  };

  if (gitExtension) {
    initialize();
  } else {
    const listener = extensions.onDidChange(() => {
      if (
        !gitExtension &&
        extensions.getExtension<GitExtension>("vscode.git")
      ) {
        gitExtension = extensions.getExtension<GitExtension>("vscode.git");
        initialize();
        listener.dispose();
      }
    });
    disposables.push(listener);
  }

  const provider = new BranchFileDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(provider)
  );

  context.subscriptions.push(
    new Disposable(() => Disposable.from(...disposables).dispose())
  );
}

// This method is called when your extension is deactivated
export function deactivate() {}

function registerCommands(stackDataProvider: StackTreeDataProvider) {
  commands.registerCommand("stack.refresh", () => stackDataProvider.refresh());
  commands.registerCommand("stack.sync", async (stack?: StackTreeItem) => {
    if (stack) {
      await stackDataProvider.sync(stack);
    }
  });
  commands.registerCommand("stack.update", async (stack?: StackTreeItem) => {
    if (stack) {
      await stackDataProvider.update(stack);
    }
  });
  commands.registerCommand("stack.new", () => stackDataProvider.newStack());
  commands.registerCommand(
    "stack.new.repository",
    async (repository?: RepositoryTreeItem) => {
      if (repository && repository.type === "repository") {
        await stackDataProvider.newStackInRepository(repository.repositoryPath);
      }
    }
  );
  commands.registerCommand("stack.pull", async (stack?: StackTreeItem) => {
    if (stack) {
      await stackDataProvider.pull(stack);
    }
  });
  commands.registerCommand("stack.push", async (stack?: StackTreeItem) => {
    if (stack) {
      await stackDataProvider.push(stack, true);
    }
  });
  commands.registerCommand(
    "stack.branch.new",
    async (stack?: StackTreeItem | BranchTreeItem) => {
      if (stack) {
        await stackDataProvider.newBranch(stack);
      }
    }
  );

  commands.registerCommand("stack.delete", async (stack?: StackTreeItem) => {
    if (stack) {
      await stackDataProvider.delete(stack);
    }
  });

  commands.registerCommand("stack.cleanup", async (stack?: StackTreeItem) => {
    if (stack) {
      await stackDataProvider.cleanup(stack);
    }
  });

  commands.registerCommand(
    "stack.switch",
    async (branchOrStack?: StackTreeItem | BranchTreeItem) => {
      if (branchOrStack) {
        if (branchOrStack.type === "stack") {
          await stackDataProvider.switchTo(
            branchOrStack.stack.sourceBranch.name
          );
        } else if (
          branchOrStack.type === "branch" &&
          branchOrStack.branch.exists
        ) {
          await stackDataProvider.switchTo(branchOrStack.branch.name);
        }
      }
    }
  );

  commands.registerCommand(
    "stack.branch.remove",
    async (branch?: BranchTreeItem) => {
      if (branch) {
        await stackDataProvider.removeBranchFromStack(branch);
      }
    }
  );

  commands.registerCommand(
    "stack.pr.open",
    async (pullRequest?: PullRequestTreeItem) => {
      if (pullRequest) {
        await stackDataProvider.openPullRequest(pullRequest);
      }
    }
  );
}
