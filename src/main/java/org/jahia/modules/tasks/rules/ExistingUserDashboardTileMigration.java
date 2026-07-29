package org.jahia.modules.tasks.rules;

import org.jahia.services.content.JCRCallback;
import org.jahia.services.content.JCRNodeIteratorWrapper;
import org.jahia.services.content.JCRNodeWrapper;
import org.jahia.services.content.JCRSessionWrapper;
import org.jahia.services.content.JCRTemplate;
import org.jahia.services.query.QueryWrapper;
import org.osgi.service.component.annotations.Activate;
import org.osgi.service.component.annotations.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.jcr.RepositoryException;
import javax.jcr.query.Query;

/**
 * Backfills the "My tasks" dashboard tile (see {@link Tasks#materializeDashboardTile(JCRNodeWrapper)})
 * onto every user that already existed before that rule started reacting to new-user creation --
 * a JCR-SQL2 query rather than a raw /users tree walk, since user storage may be sharded into
 * subfolders. Runs on every bundle activation; cheap and idempotent since each node is skipped if
 * it already has the tile.
 */
@Component(immediate = true)
public class ExistingUserDashboardTileMigration {

    private static final Logger logger = LoggerFactory.getLogger(ExistingUserDashboardTileMigration.class);

    @Activate
    public void start() {
        try {
            JCRTemplate.getInstance().doExecuteWithSystemSession((JCRCallback<Object>) this::migrate);
        } catch (RepositoryException e) {
            logger.error("Cannot backfill the tasks dashboard tile for existing users", e);
        }
    }

    private Object migrate(JCRSessionWrapper session) throws RepositoryException {
        QueryWrapper query = session.getWorkspace().getQueryManager().createQuery(
                "select * from [jnt:user] where isdescendantnode('/users')", Query.JCR_SQL2);
        JCRNodeIteratorWrapper users = query.execute().getNodes();

        boolean changed = false;
        int migrated = 0;
        while (users.hasNext()) {
            JCRNodeWrapper userNode = (JCRNodeWrapper) users.nextNode();
            if ("guest".equals(userNode.getName())) {
                continue;
            }
            if (Tasks.getInstance().materializeDashboardTile(userNode)) {
                changed = true;
                migrated++;
            }
        }

        if (changed) {
            session.save();
        }
        logger.info("Tasks dashboard tile backfill: materialized the tile for {} existing user(s)", migrated);
        return null;
    }
}
