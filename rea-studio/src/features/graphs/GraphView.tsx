import { useEffect, useRef, useState } from "react";
import cytoscape from "cytoscape";
import type { Core } from "cytoscape";
import {
  Maximize,
  Minus,
  Plus,
  Focus,
  Download,
  RotateCcw,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, message } from "../../integrations/desktop";
import { Button, Badge, Failure, Loading } from "../../components/ui";
import { useWorkspace } from "../../stores/workspace";
export default function GraphView({
  jobId,
  select,
  selected,
  selectedIsNode,
}: {
  jobId: string;
  select: (id: string) => void;
  selected: string;
  selectedIsNode: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<Core | null>(null);
  const [focus, setFocus] = useState("");
  const [filter, setFilter] = useState("");
  const [exportError, setExportError] = useState("");
  const theme = useWorkspace((s) => s.theme);
  const graph = useQuery({
    queryKey: ["graph", jobId, focus],
    queryFn: () => api.graph(jobId, focus),
    staleTime: Infinity,
  });
  useEffect(() => {
    if (!container.current || !graph.data) return;
    const nodes = graph.data.nodes.filter((n) => !filter || n.kind === filter);
    const ids = new Set(nodes.map((n) => n.id));
    const colors: Record<string, string> = {
      package: "#8d7bdb",
      "electron-main": "#6f96dc",
      "javascript-asset": "#6c91b4",
      "javascript-module": "#6c91b4",
      "source-module": "#78ab9a",
      unknown: "#b8925d",
    };
    const cy = cytoscape({
      container: container.current,
      elements: [
        ...nodes.map((n) => ({
          data: {
            id: n.id,
            label: n.label.length > 36 ? n.label.slice(0, 33) + "…" : n.label,
            color: colors[n.kind] ?? "#8291a5",
          },
        })),
        ...graph.data.edges
          .filter((e) => ids.has(e.source) && ids.has(e.target))
          .map((e) => ({
            data: {
              id: e.id,
              source: e.source,
              target: e.target,
              label: e.relation,
            },
          })),
      ],
      layout: {
        name: "breadthfirst",
        directed: true,
        spacingFactor: 1.2,
        padding: 60,
      },
      minZoom: 0.08,
      maxZoom: 3,
      wheelSensitivity: 0.2,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            "border-width": 2,
            "border-color": theme === "dark" ? "#30394a" : "#d2d9e2",
            width: 14,
            height: 14,
            label: "data(label)",
            color: theme === "dark" ? "#b8c4d7" : "#354254",
            "font-family": "Segoe UI, sans-serif",
            "font-size": 10,
            "text-valign": "bottom",
            "text-margin-y": 9,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1,
            "line-color": theme === "dark" ? "#344053" : "#c0c9d6",
            "target-arrow-color": theme === "dark" ? "#526179" : "#99a7ba",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": 8,
            color: "#7d8da3",
            "text-rotation": "autorotate",
            "text-background-color": theme === "dark" ? "#11151d" : "#f5f7fb",
            "text-background-opacity": 0.9,
            "text-background-padding": "3px",
          },
        },
        {
          selector: ":selected",
          style: {
            "border-color": "#a398fa",
            "border-width": 4,
            color: "#a398fa",
          },
        },
      ],
    });
    const saved = localStorage.getItem(`rea-graph:${jobId}:${focus}:${filter}`);
    if (saved) {
      try {
        const state = JSON.parse(saved);
        if (typeof state.zoom === "number" && state.pan) {
          cy.zoom(state.zoom);
          cy.pan(state.pan);
        }
      } catch {
        /* Invalid view state has no effect on Evidence. */
      }
    }
    cy.on("tap", "node, edge", (event) => select(event.target.id()));
    cy.on("pan zoom", () =>
      localStorage.setItem(
        `rea-graph:${jobId}:${focus}:${filter}`,
        JSON.stringify({ zoom: cy.zoom(), pan: cy.pan() }),
      ),
    );
    instance.current = cy;
    const resize = new ResizeObserver(() => cy.resize());
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      cy.destroy();
      instance.current = null;
    };
  }, [graph.data, filter, jobId, focus, theme, select]);
  useEffect(() => {
    const cy = instance.current;
    if (!cy) return;
    cy.elements().unselect();
    if (selected) cy.getElementById(selected).select();
  }, [selected, graph.data]);
  if (graph.isPending)
    return <Loading label="Loading observed graph relationships…" />;
  if (graph.error) return <Failure text={message(graph.error)} />;
  return (
    <div className="graph-view">
      <div className="view-toolbar">
        <span className="muted">APPLICATION GRAPH</span>
        <select
          aria-label="Filter graph node types"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="">All entity types</option>
          {[...new Set(graph.data.nodes.map((n) => n.kind))].sort().map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <div className="grow" />
        <Button
          variant="ghost"
          onClick={() => {
            setFocus(selected);
            setFilter("");
          }}
          disabled={!selectedIsNode}
        >
          <Focus size={14} />
          Expand neighborhood
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setFocus("");
            setFilter("");
          }}
        >
          <RotateCcw size={14} />
          Overview
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            void api
              .export(jobId, "graph", focus)
              .catch((e) => setExportError(message(e)));
          }}
        >
          <Download size={14} />
          Export view
        </Button>
      </div>
      {exportError && <Failure text={exportError} />}
      <div className="graph-canvas" ref={container} />
      <div className="graph-controls">
        <Button
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() =>
            instance.current?.zoom((instance.current?.zoom() ?? 1) * 1.2)
          }
        >
          <Plus size={15} />
        </Button>
        <Button
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() =>
            instance.current?.zoom((instance.current?.zoom() ?? 1) / 1.2)
          }
        >
          <Minus size={15} />
        </Button>
        <Button
          title="Fit graph"
          aria-label="Fit graph"
          onClick={() => instance.current?.fit(undefined, 60)}
        >
          <Maximize size={15} />
        </Button>
      </div>
      <div className="graph-caption">
        <Badge tone={graph.data.limited ? "amber" : ""}>
          {graph.data.limited ? "Partial view" : "Loaded graph"}
        </Badge>
        <span>
          {graph.data.nodes.length} / {graph.data.total_nodes} entities ·{" "}
          {graph.data.edges.length} / {graph.data.total_edges} relationships ·
          upstream coverage: {graph.data.coverage}
        </span>
        <span className="grow" />
        <span>Click to inspect · Scroll to zoom · Drag to pan</span>
      </div>
    </div>
  );
}
