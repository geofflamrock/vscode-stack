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
import { GitExtension, Repository } from "./typings/git";
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
    logger.info("Initializing Stack extension...");
    gitExtension!.activate().then((extension) => {
      logger.info("Git extension activated");
      let stackDataProvider: StackTreeDataProvider | undefined;

      const initializeStackProvider = () => {
        const gitAPI = extension.getAPI(1);
        if (!gitAPI.repositories.length) {
          logger.info("Waiting for git repositories to be discovered...");
          return;
        }

        logger.info(`Found ${gitAPI.repositories.length} git repositories`);

        // Test stack command availability
        const testRepo = gitAPI.repositories[0];
        if (testRepo) {
          logger.info(`Testing stack command in: ${testRepo.rootUri.fsPath}`);
          const testApi = new StackApi(testRepo, logger);
          testApi.getStacks().then(stacks => {
            logger.info(`Test result: Found ${stacks.length} stacks in ${testRepo.rootUri.fsPath}`);
          }).catch(error => {
            logger.error(`Test failed: ${error}`);
          });
        }

        // Create APIs for all repositories
        const apis = new Map<Repository, StackApi>();
        for (const repo of gitAPI.repositories) {
          apis.set(repo, new StackApi(repo, logger));
          logger.info(`Initialized stack API for repository: ${repo.rootUri.fsPath}`);
        }

        if (stackDataProvider) {
          // Update existing provider with new repositories
          stackDataProvider.updateRepositories(gitAPI.repositories, apis, logger);
        } else {
          // Create new provider
          stackDataProvider = new StackTreeDataProvider(
            gitAPI.repositories,
            apis,
            logger
          );

          disposables.push(
            window.registerTreeDataProvider("stack", stackDataProvider)
          );

          registerCommands(stackDataProvider);
        }
      };

      const onDidChangeGitExtensionEnablement = (enabled: boolean) => {
        if (enabled) {
          const gitAPI = extension.getAPI(1);
          
          // Try to initialize immediately
          initializeStackProvider();
          
          // Listen for repository changes
          disposables.push(
            gitAPI.onDidOpenRepository(() => {
              logger.info("Repository opened, reinitializing stack provider");
              initializeStackProvider();
            })
          );
          
          disposables.push(
            gitAPI.onDidCloseRepository(() => {
              logger.info("Repository closed, reinitializing stack provider");
              initializeStackProvider();
            })
          );
        } else {
          Disposable.from(...disposables).dispose();
        }
      };

      disposables.push(
        extension.onDidChangeEnablement(onDidChangeGitExtensionEnablement)
      );
      logger.info(`Git extension enabled: ${extension.enabled}`);
      onDidChangeGitExtensionEnablement(extension.enabled);
    });
  };

  if (gitExtension) {
    logger.info("Git extension found, initializing...");
    initialize();
  } else {
    logger.warn("Git extension not found, waiting for it to load...");
    const listener = extensions.onDidChange(() => {
      if (
        !gitExtension &&
        extensions.getExtension<GitExtension>("vscode.git")
      ) {
        gitExtension = extensions.getExtension<GitExtension>("vscode.git");
        logger.info("Git extension loaded, initializing...");
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
  commands.registerCommand("stack.new", () => {
    // For new stack command, use default behavior (will prompt if multiple repos)
    stackDataProvider.newStack();
  });
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
            branchOrStack.stack.sourceBranch.name,
            branchOrStack.api
          );
        } else if (
          branchOrStack.type === "branch" &&
          branchOrStack.branch.exists
        ) {
          await stackDataProvider.switchTo(
            branchOrStack.branch.name,
            branchOrStack.api
          );
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
