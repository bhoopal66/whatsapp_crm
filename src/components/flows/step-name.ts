import { useTranslations } from "next-intl";
import type { BuilderNode } from "./shared";

type StepLike = Pick<BuilderNode, "node_key" | "node_type">;

/**
 * A step's plain name for people: its type label ("Send message",
 * "Ask a question"), numbered when the flow has several of that type
 * ("Send message 2"). The internal node key is never shown for this.
 */
export function stepOrdinal(
  nodes: StepLike[],
  key: string,
): { type: string; n: number; total: number } | null {
  const node = nodes.find((n) => n.node_key === key);
  if (!node) return null;
  const same = nodes.filter((n) => n.node_type === node.node_type);
  return {
    type: node.node_type,
    n: same.findIndex((n) => n.node_key === key) + 1,
    total: same.length,
  };
}

export function useStepNamer(nodes: StepLike[]) {
  const t = useTranslations("Flows.builder");
  return (key: string): string => {
    const o = stepOrdinal(nodes, key);
    if (!o) return "";
    const label = t(`nodes.${o.type}.label` as never);
    return o.total > 1 ? `${label} ${o.n}` : label;
  };
}
