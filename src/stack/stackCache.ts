import { IStackApi } from "./index";
import { Stack, StackBranch } from "../types";

export class StackCache {
  private cache: Stack[] | null = null;

  constructor(private readonly stackApi: IStackApi) {}

  async getStacks(): Promise<Stack[]> {
    if (!this.cache) {
      this.cache = await this.stackApi.getStacks();
    }
    return this.cache;
  }

  async refreshStacks(): Promise<Stack[]> {
    this.cache = await this.stackApi.getStacks();
    return this.cache;
  }

  clearCache(): void {
    this.cache = null;
  }

  async getStackByName(name: string): Promise<Stack | undefined> {
    if (!this.cache) {
      await this.getStacks();
    }
    return this.cache?.find((stack) => stack.name === name);
  }

  async getBranchByName(
    stackName: string,
    branchName: string
  ): Promise<StackBranch | undefined> {
    const stack = await this.getStackByName(stackName);
    return stack?.branches.find((branch) => branch.name === branchName);
  }
}
