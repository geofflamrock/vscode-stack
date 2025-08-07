import { IStackApi } from "./index";
import { Stack, StackBranch } from "../types";

export class StackCache {
  private cache: Stack[] | null = null;
  private logger?: any;

  constructor(private readonly stackApi: IStackApi, logger?: any) {
    this.logger = logger;
  }

  async getStacks(): Promise<Stack[]> {
    this.logger?.info('StackCache.getStacks called');
    if (!this.cache) {
      this.logger?.info('Cache is null, calling stackApi.getStacks()');
      this.cache = await this.stackApi.getStacks();
      this.logger?.info(`StackCache: Retrieved ${this.cache.length} stacks from API`);
    } else {
      this.logger?.info(`StackCache: Returning cached ${this.cache.length} stacks`);
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
