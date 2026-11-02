import org.jahia.api.Constants
import org.jahia.services.content.JCRSessionFactory
import org.jahia.services.content.JCRSessionWrapper
import org.jahia.services.workflow.WorkflowDefinition
import org.jahia.services.workflow.WorkflowService

// Starts ONE publication workflow covering SEVERAL nodes -- what jContent does when an editor
// publishes a selection, and what no @jahia/cypress helper can do: startWorkflow() takes a single
// pathOrId, so calling it per node would give N processes of one item each rather than one process
// of N items. The whole point of this fixture is the multi-item request, so it goes through
// WorkflowService#startProcess directly.

String[] paths = "PATHS".split(",")

JCRSessionWrapper session = JCRSessionFactory.getInstance()
        .getCurrentUserSession(Constants.EDIT_WORKSPACE, Locale.ENGLISH)

List<String> nodeIds = new ArrayList<String>()
for (String path : paths) {
    nodeIds.add(session.getNode(path.trim()).getIdentifier())
}

WorkflowService workflowService = WorkflowService.getInstance()

// Discovered, not hardcoded: which publication workflow is installed depends on the modules on the
// instance and the definition key differs between them, so a literal key would make this fixture
// pass or fail on module selection rather than on the behaviour under test.
List<WorkflowDefinition> definitions = workflowService.getWorkflowDefinitionsForType("publish", Locale.ENGLISH)
if (definitions.isEmpty()) {
    throw new IllegalStateException("No workflow of type 'publish' is installed on this instance")
}

WorkflowDefinition definition = definitions.get(0)

String processId = workflowService.startProcess(nodeIds, session, definition.getKey(), definition.getProvider(),
        new HashMap<String, Object>(), null)

if (processId == null) {
    // startProcess answers null when none of the nodes passed the start permission check, which
    // would otherwise surface much later as "the board shows no workflow task" with no reason.
    throw new IllegalStateException("startProcess returned null -- no node passed the start permission check")
}

return processId
