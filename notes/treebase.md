We're going to make a pi package in the current folder that contains one extension. The goal of the extension is to make a new command, `/treebase`, which is based on the native pi `/tree` command, but adds functionality simlar to `git rebase --interactive`. The idea will be that the flow goes like so:

1. User uses `/treebase`
2. The same interface as the native `/tree` command appears
3. Once the user chooses the tree node they want to travel to, we flatten the path from the current node to the selected node into a single list of nodes (same logic as internal tree traversal).
4. Instead of summarizing directly, this list is then presented to the user. Next to each node, an indication of the action that will be performed to that node gets displayed. These options are: pick (P), summarize-high (H), low (L), drop (D).
5. The user can then edit the action to be performed to each node. Nodes that get "pick"ed will be kept verbatim. Nodes that are marked "high" or "low" will be summarized with high or low importance respectively, and nodes that are "drop"ed will be discarded entirely. By default, navigation happens between entire turns, and modifications that happen to a turn
are applied to all sub-nodes (i.e. tool calls).
6. Once the user confirms their choices, summarization then happens based on the rules of their selection and a new synthetic branch is added as sibling of the original target node.

The tool should only support moving backwards chronologically in the tree, i.e. if the user takes a path that moves forward towards a leaf, they should just get teleported to the selected node.
