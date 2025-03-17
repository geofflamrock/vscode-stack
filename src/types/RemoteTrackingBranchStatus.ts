export type RemoteTrackingBranchStatus = {
  name: string;
  exists: boolean;
  ahead: number;
  behind: number;
};
