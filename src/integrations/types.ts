import type { MondayItem } from "../services/mondayClient.js";

export type IntegrationAction = "publishLoad" | "removeLoad";

export type IntegrationContext = {
  boardId: string;
  itemId: string;
  statusColumnId: string;
  item: MondayItem;
};

export type IntegrationResult =
  | { status: "success"; message?: string }
  | { status: "error"; message: string }
  | { status: "requires_two_step"; message: string };

export interface FreightIntegration {
  name: string;
  publishLoad(context: IntegrationContext): Promise<IntegrationResult>;
  removeLoad(context: IntegrationContext): Promise<IntegrationResult>;
  completeTwoStepPublish?(context: IntegrationContext, code: string): Promise<IntegrationResult>;
}
