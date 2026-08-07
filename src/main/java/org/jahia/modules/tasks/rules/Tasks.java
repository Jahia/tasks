/*
 * ==========================================================================================
 * =                   JAHIA'S DUAL LICENSING - IMPORTANT INFORMATION                       =
 * ==========================================================================================
 *
 *                                 http://www.jahia.com
 *
 *     Copyright (C) 2002-2020 Jahia Solutions Group SA. All rights reserved.
 *
 *     THIS FILE IS AVAILABLE UNDER TWO DIFFERENT LICENSES:
 *     1/GPL OR 2/JSEL
 *
 *     1/ GPL
 *     ==================================================================================
 *
 *     IF YOU DECIDE TO CHOOSE THE GPL LICENSE, YOU MUST COMPLY WITH THE FOLLOWING TERMS:
 *
 *     This program is free software: you can redistribute it and/or modify
 *     it under the terms of the GNU General Public License as published by
 *     the Free Software Foundation, either version 3 of the License, or
 *     (at your option) any later version.
 *
 *     This program is distributed in the hope that it will be useful,
 *     but WITHOUT ANY WARRANTY; without even the implied warranty of
 *     MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 *     GNU General Public License for more details.
 *
 *     You should have received a copy of the GNU General Public License
 *     along with this program. If not, see <http://www.gnu.org/licenses/>.
 *
 *
 *     2/ JSEL - Commercial and Supported Versions of the program
 *     ===================================================================================
 *
 *     IF YOU DECIDE TO CHOOSE THE JSEL LICENSE, YOU MUST COMPLY WITH THE FOLLOWING TERMS:
 *
 *     Alternatively, commercial and supported versions of the program - also known as
 *     Enterprise Distributions - must be used in accordance with the terms and conditions
 *     contained in a separate written agreement between you and Jahia Solutions Group SA.
 *
 *     If you are unsure which license is appropriate for your use,
 *     please contact the sales department at sales@jahia.com.
 */
package org.jahia.modules.tasks.rules;

import org.apache.commons.lang.StringUtils;
import org.jahia.registries.ServicesRegistry;
import org.jahia.services.content.JCRNodeWrapper;
import org.jahia.services.content.JCRPropertyWrapper;
import org.jahia.services.content.decorator.JCRUserNode;
import org.jahia.services.content.rules.AddedNodeFact;
import org.jahia.services.usermanager.JahiaUser;
import org.jahia.services.workflow.WorkflowService;
import org.jahia.services.workflow.WorkflowVariable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.jcr.PropertyIterator;
import javax.jcr.RepositoryException;
import javax.jcr.Value;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;

/**
 * @author rincevent
 * @since JAHIA 6.5
 *        Created : 5 janv. 2010
 */
public class Tasks {
    private transient static Logger logger = LoggerFactory.getLogger(Tasks.class);

    private static final String MY_TASKS_NODE_NAME = "my-tasks";
    private static final String PAGECONTENT_NODE_NAME = "pagecontent";

    private static Tasks instance;

    private Tasks() {
        super();
    }

    public static synchronized Tasks getInstance() {
        if (instance == null) {
            instance = new Tasks();
        }
        return instance;
    }

    /**
     * Materializes the "My tasks" dashboard tile's default content directly onto a user node.
     * The "tasks" contentTemplate's own default pagecontent (see src/main/import/repository.xml)
     * is never inherited onto the live /users/&lt;username&gt; node the way a jnt:page inherits its
     * template's default area content -- the dashboard iframe just renders "No item found" instead.
     * Idempotent: skips users that already have this content (e.g. re-running after a manual edit).
     */
    public void materializeDashboardTile(AddedNodeFact node) {
        try {
            materializeDashboardTile(node.getNode());
        } catch (RepositoryException e) {
            logger.error("Cannot materialize the tasks dashboard tile for new user node", e);
        }
    }

    /**
     * @return true if the tile's content was just created, false if the user node already had it
     *         (also used by {@link ExistingUserDashboardTileMigration} to backfill users that
     *         predate this rule, so it needs to be visible outside this class).
     */
    boolean materializeDashboardTile(JCRNodeWrapper userNode) throws RepositoryException {
        if (userNode.hasNode("pagecontent/my-tasks/currentUserTasks")) {
            return false;
        }

        JCRNodeWrapper pagecontent = userNode.hasNode(PAGECONTENT_NODE_NAME)
                ? userNode.getNode(PAGECONTENT_NODE_NAME)
                : userNode.addNode(PAGECONTENT_NODE_NAME, "jnt:contentList");
        JCRNodeWrapper myTasks = pagecontent.hasNode(MY_TASKS_NODE_NAME)
                ? pagecontent.getNode(MY_TASKS_NODE_NAME)
                : pagecontent.addNode(MY_TASKS_NODE_NAME, "jnt:contentList");

        // Mirrors the "tasks" contentTemplate's own default currentUserTasks node
        // (src/main/import/repository.xml) -- keep the two in sync if either changes.
        JCRNodeWrapper currentUserTasks = myTasks.addNode("currentUserTasks", "jnt:currentUserTasks");
        currentUserTasks.addMixin("jmix:renderable");
        currentUserTasks.setProperty("displayAssignee", true);
        currentUserTasks.setProperty("displayCreator", true);
        currentUserTasks.setProperty("displayState", true);
        currentUserTasks.setProperty("filterOnAssignee", "assignedToMeOrUnassigned");
        currentUserTasks.setProperty("filterOnStates", new String[]{"active", "started", "suspended"});
        currentUserTasks.setProperty("sortBy", "jcr:created");
        return true;
    }

    public void assignTask(AddedNodeFact node, String username) {
        JCRUserNode user = ServicesRegistry.getInstance().getJahiaUserManagerService().lookupUserByPath(username);
        try {
            JCRNodeWrapper jcrNodeWrapper = node.getNode();
            String taskId = jcrNodeWrapper.getProperty("taskId").getString();
            String provider = jcrNodeWrapper.getProperty("provider").getString();
            WorkflowService.getInstance().assignTask(taskId, provider, user != null ? user.getJahiaUser() : null);
        } catch (RepositoryException e) {
            logger.error("cannot assign task", e);
        }
    }

    public void completeTask(AddedNodeFact node, JahiaUser user) {
        try {
            JCRNodeWrapper jcrNodeWrapper = node.getNode();
            String taskId = jcrNodeWrapper.getProperty("taskId").getString();
            String provider = jcrNodeWrapper.getProperty("provider").getString();
            String outcome = jcrNodeWrapper.getProperty("finalOutcome").getString();

            HashMap<String, Object> map = null;
            if (jcrNodeWrapper.hasNode("taskData")) {
                map = new HashMap<String, Object>();

                JCRNodeWrapper data = jcrNodeWrapper.getNode("taskData");
                PropertyIterator pi = data.getProperties();
                while (pi.hasNext()) {
                    JCRPropertyWrapper property = (JCRPropertyWrapper) pi.next();
                    if (!property.getDefinition().getDeclaringNodeType().getName().equals("nt:base") && !property.getDefinition().getName().equals("jcr:uuid")) {
                        if (property.isMultiple()) {
                            List<WorkflowVariable> values = new ArrayList<WorkflowVariable>();
                            for (Value value : property.getValues()) {
                                String s = value.getString();
                                if (StringUtils.isNotBlank(s)) {
                                    values.add(new WorkflowVariable(s, value.getType()));
                                }
                            }
                            map.put(property.getName(), values);
                        } else {
                            String s = property.getString();
                            if (StringUtils.isNotBlank(s)) {
                                map.put(property.getName(), new WorkflowVariable(s, property.getType()));
                            }
                        }
                    }
                }
            }

            WorkflowService.getInstance().completeTask(taskId, user, provider, outcome, map);
        } catch (RepositoryException e) {
            logger.error("cannot complete task", e);
        }
    }

}
