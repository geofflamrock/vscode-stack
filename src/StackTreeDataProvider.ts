import * as vscode from "vscode";
import * as cp from "child_process";
import { EOL } from "os";

type Stack = {
  name: string;
  sourceBranch: string;
  branches: string[];
};

export class StackTreeDataProvider
  implements vscode.TreeDataProvider<StackTreeItem>
{
  constructor(private workspaceRoot?: string) {}
  getTreeItem(element: StackTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: StackTreeItem): Promise<StackTreeItem[]> {
    if (!this.workspaceRoot) {
      vscode.window.showInformationMessage("No stack in empty workspace");
      return [];
    }

    const stacks = await execShell(
      `stack list --json --working-dir ${this.workspaceRoot}`
    );

    const parsedStacks: Stack[] = JSON.parse(stacks);

    return parsedStacks.map((stack) => {
      return new StackTreeItem(stack, vscode.TreeItemCollapsibleState.None);
    });
  }
}

const execShell = (cmd: string) =>
  new Promise<string>((resolve, reject) => {
    cp.exec(cmd, (err, out) => {
      if (err) {
        return reject(err);
      }
      return resolve(out.replaceAll(EOL, ""));
    });
  });

class StackTreeItem extends vscode.TreeItem {
  constructor(
    public readonly stack: Stack,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(stack.name, collapsibleState);
    this.tooltip = `${this.stack.name}`;
    this.description = `${this.stack.sourceBranch} (${this.stack.branches.length} branches)`;
  }
}
