// The light entry has no renderer: both names are absent from its exports.
import { buildStandaloneHtml, graphToMermaid } from '@djodjonx/neosyringe-ui/serialize';

export const renderers = [buildStandaloneHtml, graphToMermaid];
