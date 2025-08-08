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
  StackTreeDataProvider,
  StackTreeItem,
} from "./StackTreeDataProvider";
import { MultiRepoStackTreeDataProvider } from "./MultiRepoStackTreeDataProvider";
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

  const initialize = () => {
    gitExtension!.activate().then((extension: any) => {
      const onDidChangeGitExtensionEnablement = (enabled: boolean) => {
        if (enabled) {
          const gitAPI = extension.getAPI(1);
          if (!gitAPI.repositories.length) {
            logger.warn("No git repositories found in the workspace.");
            return;
          }

          const perRepoProviders = gitAPI.repositories.map((repo: any) => {
            const provider = new StackTreeDataProvider(
              new StackApi(repo, logger)
            );
            (provider as any).repositoryPath = repo.rootUri.fsPath;
            (provider as any).repositoryName = repo.rootUri.path
              .split(/[/\\]/)
              .pop();
            return provider;
          });

          const aggregatedProvider = new MultiRepoStackTreeDataProvider(
            perRepoProviders,
            logger
          );

          disposables.push(
            window.registerTreeDataProvider("stack", aggregatedProvider)
          );

          registerCommands(aggregatedProvider);
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

function registerCommands(provider: any) {
  commands.registerCommand("stack.refresh", () => provider.refresh());
  commands.registerCommand("stack.sync", async (stack?: StackTreeItem) => {
    if (stack) {
      await provider.sync(stack);
    }
  });
  commands.registerCommand("stack.update", async (stack?: StackTreeItem) => {
    if (stack) {
      await provider.update(stack);
    }
  });
  commands.registerCommand("stack.new", () => provider.newStack());
  commands.registerCommand("stack.pull", async (stack?: StackTreeItem) => {
    if (stack) {
      await provider.pull(stack);
    }
  });
  commands.registerCommand("stack.push", async (stack?: StackTreeItem) => {
    if (stack) {
      await provider.push(stack, true);
    }
  });
  commands.registerCommand(
    "stack.branch.new",
    async (stack?: StackTreeItem | BranchTreeItem) => {
      if (stack) {
        await provider.newBranch(stack);
      }
    }
  );
  commands.registerCommand("stack.delete", async (stack?: StackTreeItem) => {
    if (stack) {
      await provider.delete(stack);
    }
  });
  commands.registerCommand("stack.cleanup", async (stack?: StackTreeItem) => {
    if (stack) {
      await provider.cleanup(stack);
    }
  });
  commands.registerCommand(
    "stack.switch",
    async (branchOrStack?: StackTreeItem | BranchTreeItem) => {
      if (branchOrStack) {
        await provider.switchTo(branchOrStack);
      }
    }
  );
  commands.registerCommand(
    "stack.branch.remove",
    async (branch?: BranchTreeItem) => {
      if (branch) {
        await provider.removeBranchFromStack(branch);
      }
    }
  );
  commands.registerCommand(
    "stack.pr.open",
    async (pullRequest?: PullRequestTreeItem) => {
      if (pullRequest) {
        await provider.openPullRequest(pullRequest);
      }
    }
  );
}
