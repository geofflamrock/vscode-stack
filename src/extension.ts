// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import {
  ExtensionContext,
  workspace,
  window,
  Disposable,
  commands,
} from "vscode";
import {
  BranchTreeItem,
  PullRequestTreeItem,
  StackTreeDataProvider,
  StackTreeItem,
} from "./StackTreeDataProvider";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
  const disposables: Disposable[] = [];

  const logger = window.createOutputChannel("Stack", { log: true });
  disposables.push(logger);

  const rootPath =
    workspace.workspaceFolders && workspace.workspaceFolders.length > 0
      ? workspace.workspaceFolders[0].uri.fsPath
      : undefined;

  const stackDataProvider = new StackTreeDataProvider(rootPath, logger);

  disposables.push(window.registerTreeDataProvider("stack", stackDataProvider));

  commands.registerCommand("stack.refresh", () => stackDataProvider.refresh());
  commands.registerCommand("stack.sync", async (stack?: StackTreeItem) => {
    if (stack) {
      await stackDataProvider.sync(stack);
    }
  });
  commands.registerCommand("stack.new", () => stackDataProvider.newStack());
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
    async (stack?: StackTreeItem) => {
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

  commands.registerCommand("stack.switch", async (branch?: BranchTreeItem) => {
    if (branch) {
      await stackDataProvider.switchTo(branch);
    }
  });

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

  context.subscriptions.push(
    new Disposable(() => Disposable.from(...disposables).dispose())
  );
}

// This method is called when your extension is deactivated
export function deactivate() {}
