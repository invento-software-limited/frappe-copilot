import * as fs from 'fs';
import * as path from 'path';
import { AgentGraph, GraphNode, GraphNodeStatus, GraphState } from '../types';

const GRAPH_FILE = 'graph.json';

/**
 * Manages the agent workflow graph for a project.
 * Persisted as .frappe-copilot/agents/graph.json
 * There is ONE graph per project.
 */
export class GraphStore {
  private graph: AgentGraph | null = null;
  private graphPath: string;

  constructor(frappeCopilotPath: string) {
    this.graphPath = path.join(frappeCopilotPath, 'agents', GRAPH_FILE);
    this.load();
  }

  /** Load the graph from disk. */
  private load(): void {
    try {
      if (fs.existsSync(this.graphPath)) {
        const raw = fs.readFileSync(this.graphPath, 'utf-8');
        this.graph = JSON.parse(raw) as AgentGraph;
      }
    } catch {
      this.graph = null;
    }
  }

  /** Save the graph to disk. */
  private save(): void {
    try {
      const dir = path.dirname(this.graphPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (this.graph) {
        this.graph.updatedAt = new Date().toISOString();
      }
      fs.writeFileSync(this.graphPath, JSON.stringify(this.graph, null, 2));
    } catch (err) {
      console.error('Failed to save agent graph:', err);
    }
  }

  /** Create a new graph for the project. */
  init(name: string): AgentGraph {
    const graph: AgentGraph = {
      id: `graph-${Date.now().toString(36)}`,
      name,
      nodes: [],
      edges: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentState: 'idle',
    };
    this.graph = graph;
    this.save();
    return graph;
  }

  /** Get the current graph, or create a default one. */
  get(): AgentGraph {
    if (!this.graph) {
      return this.init('Project Workflow');
    }
    return this.graph;
  }

  /** Add a node to the graph. */
  addNode(node: GraphNode): void {
    if (!this.graph) this.init('Project Workflow');
    this.graph!.nodes.push(node);
    this.save();
  }

  /** Update a node's status, progress, and/or result. */
  updateNode(
    nodeId: string,
    updates: Partial<Pick<GraphNode, 'status' | 'progress' | 'result' | 'details'>>
  ): void {
    if (!this.graph) return;
    const node = this.graph.nodes.find(n => n.id === nodeId);
    if (node) {
      Object.assign(node, updates);
      this.save();
    }
  }

  /** Add an edge between two nodes. */
  addEdge(from: string, to: string, label?: string): void {
    if (!this.graph) this.init('Project Workflow');
    // Skip if edge already exists
    const exists = this.graph!.edges.some(e => e.from === from && e.to === to);
    if (!exists) {
      this.graph!.edges.push({ from, to, label });
      this.save();
    }
  }

  /** Set the overall graph state. */
  setState(state: GraphState): void {
    if (!this.graph) return;
    this.graph.currentState = state;
    this.save();
  }

  /** Reset the graph to empty. */
  reset(name?: string): void {
    this.init(name || 'Project Workflow');
  }

  /** Build a standard extraction graph structure. */
  buildExtractionGraph(
    fileName: string,
    chunkCount: number
  ): { inputNode: GraphNode; readerNodes: GraphNode[]; mergerNode: GraphNode; outputNode: GraphNode } {
    this.reset(`Extraction: ${fileName}`);

    const g = this.graph!;

    // Input node
    const inputNode: GraphNode = {
      id: 'input',
      type: 'input',
      label: `📄 ${fileName}`,
      description: 'Source document',
      status: 'completed',
    };
    g.nodes.push(inputNode);

    // Splitter node
    const splitterNode: GraphNode = {
      id: 'splitter',
      type: 'splitter',
      label: chunkCount > 1 ? `✂️ Split into ${chunkCount} parts` : '📖 Read full',
      description: chunkCount > 1 ? `Content split into ${chunkCount} chunks for parallel processing` : 'Content processed as single chunk',
      status: 'completed',
    };
    g.nodes.push(splitterNode);
    g.edges.push({ from: 'input', to: 'splitter' });

    // Reader nodes (one per chunk)
    const readerNodes: GraphNode[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const node: GraphNode = {
        id: `reader-${i}`,
        type: 'reader',
        label: `🔍 Reader ${i + 1}`,
        description: `Analyzing part ${i + 1}`,
        status: 'pending',
        progress: 0,
      };
      g.nodes.push(node);
      g.edges.push({ from: 'splitter', to: `reader-${i}`, label: `part ${i + 1}` });
      readerNodes.push(node);
    }

    // Merger node
    const mergerNode: GraphNode = {
      id: 'merger',
      type: 'merger',
      label: '🧩 Merger',
      description: 'Combining all analyses into unified spec',
      status: 'pending',
    };
    g.nodes.push(mergerNode);
    for (let i = 0; i < chunkCount; i++) {
      g.edges.push({ from: `reader-${i}`, to: 'merger' });
    }

    // Output node
    const outputNode: GraphNode = {
      id: 'output',
      type: 'output',
      label: '✅ Understanding',
      description: 'Final extracted specification',
      status: 'pending',
    };
    g.nodes.push(outputNode);
    g.edges.push({ from: 'merger', to: 'output' });

    this.save();
    return { inputNode, readerNodes, mergerNode, outputNode };
  }
}
