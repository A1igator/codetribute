import { hot } from 'react-hot-loader';
import React, { Component } from 'react';
import { graphql, compose, withApollo } from 'react-apollo';
import dotProp from 'dot-prop-immutable';
import { mergeAll, memoizeWith, mergeWith, concat } from 'ramda';
import uniqBy from 'lodash.uniqby';
import { withStyles } from '@material-ui/core/styles';
import projects from '../../data/loader';
import Spinner from '../../components/Spinner';
import ErrorPanel from '../../components/ErrorPanel';
import TasksTable from '../../components/TasksTable';
import githubInfoQuery from '../githubInfo.graphql';
import bugsQuery from '../bugs.graphql';
import commentsQuery from '../comments.graphql';
import {
  GOOD_FIRST_BUG,
  MENTORED_BUG,
  BUGZILLA_PAGE_SIZE,
  BUGZILLA_PAGING_OPTIONS,
  BUGZILLA_SEARCH_OPTIONS,
  BUGZILLA_UNASSIGNED,
} from '../../utils/constants';
import hasNextPage from '../../utils/hasNextPage';
import isStringEqualIgnoreCase from '../../utils/isStringEqualIgnoreCase';
import extractWhiteboardTags from '../../utils/extractWhiteboardTags';
import Dashboard from '../../components/Dashboard';
import ProjectIntroductionCard from '../../components/ProjectIntroductionCard';

const getProductsInfoWithoutLabel = products => {
  if (!products) {
    return [];
  }

  return products.reduce(
    (prev, product) =>
      product.label ? [...prev, ...product.products] : [...prev, product],
    []
  );
};

const productsWithNoComponents = products =>
  products.filter(product => typeof product === 'string');
const tagReposMapping = repositories =>
  Object.keys(repositories).reduce((previousMappings, repoName) => {
    const tags = repositories[repoName];
    const labels = typeof tags === 'string' ? [tags] : tags;
    const mappings = labels.reduce(
      (labels, label) => ({
        ...labels,
        [label]: [...(previousMappings[label] || []), repoName],
      }),
      {}
    );

    return {
      ...previousMappings,
      ...mappings,
    };
  }, {});
const pageCursors = {
  github: {},
  bzGoodFirst: {},
  bzMentored: {},
};
const getProjectLabels = memoizeWith(
  (...args) => args.join('-'),
  (projectName, bugProduct, bugComponent) => {
    // A bug might have multiple labels when one of the entries only doesn't
    // specify product name
    const relatedProductQueriesWithLabel = (
      projects[projectName].products || []
    ).filter(
      query =>
        !!query.label &&
        query.products.some(innerProduct => {
          if (typeof innerProduct === 'string') {
            return isStringEqualIgnoreCase(bugProduct, innerProduct);
          }

          if (
            isStringEqualIgnoreCase(bugProduct, Object.keys(innerProduct)[0])
          ) {
            const innerComponents = Object.values(innerProduct)[0];

            return innerComponents.some(component =>
              isStringEqualIgnoreCase(component, bugComponent)
            );
          }

          return false;
        })
    );

    return relatedProductQueriesWithLabel.length
      ? relatedProductQueriesWithLabel.map(q => q.label)
      : [bugComponent];
  }
);

@hot(module)
@compose(
  graphql(githubInfoQuery, {
    skip: ({
      match: {
        params: { project },
      },
    }) => !projects[project].repositories,
    name: 'github',
    options: () => ({
      fetchPolicy: 'network-only',
      variables: {
        searchQuery: '',
        type: 'ISSUE',
        after: null,
      },
      context: {
        client: 'github',
      },
    }),
  }),
  graphql(bugsQuery, {
    skip: ({
      match: {
        params: { project },
      },
    }) => !projects[project].products,
    name: 'bugzilla',
    options: ({
      match: {
        params: { project },
      },
    }) => {
      const productsInfo = getProductsInfoWithoutLabel(
        projects[project].products
      );

      return {
        fetchPolicy: 'network-only',
        variables: {
          goodFirst: {
            ...BUGZILLA_SEARCH_OPTIONS,
            keywords: [GOOD_FIRST_BUG],
            // get all the product with no component as it can be
            // merged as an OR query if it exists
            ...(productsWithNoComponents(productsInfo).length
              ? { products: productsWithNoComponents(productsInfo) }
              : {
                  // otherwise, get only the first product and its components
                  // as component is not unique for product thus can't be merged
                  products: Object.keys(productsInfo[0])[0],
                  components: Object.values(productsInfo[0])[0],
                }),
          },
          mentored: {
            ...BUGZILLA_SEARCH_OPTIONS,
            ...MENTORED_BUG,
            // get all the product with no component as it can be
            // merged as an OR query if it exists
            ...(productsWithNoComponents(productsInfo).length
              ? { products: productsWithNoComponents(productsInfo) }
              : {
                  // otherwise, get only the first product and its components
                  // as component is not unique for product thus can't be merged
                  products: Object.keys(productsInfo[0])[0],
                  components: Object.values(productsInfo[0])[0],
                }),
          },
          paging: {
            ...BUGZILLA_PAGING_OPTIONS,
          },
        },
        goodFirstPaging: {
          ...BUGZILLA_PAGING_OPTIONS,
        },
        mentoredPaging: {
          ...BUGZILLA_PAGING_OPTIONS,
        },
        context: {
          client: 'bugzilla',
        },
      };
    },
  })
)
@withApollo
@withStyles(theme => ({
  spinner: {
    marginTop: 3 * theme.spacing.unit,
  },
}))
export default class Project extends Component {
  state = {
    isNextPageLoading: false,
  };

  componentDidUpdate(prevProps) {
    if (
      (prevProps.bugzilla &&
        prevProps.bugzilla.loading &&
        !this.props.bugzilla.loading) ||
      (!prevProps.bugzilla &&
        prevProps.github.loading &&
        !this.props.github.loading)
    ) {
      this.handleLoad();
    }
  }

  componentDidMount() {
    pageCursors.github = {};
    pageCursors.bzGoodFirst = {};
    pageCursors.bzMentored = {};
  }

  handleBugInfoClick = memoizeWith(
    id => id,
    async id => {
      try {
        const {
          data: { comments },
        } = await this.props.client.query({
          query: commentsQuery,
          variables: { id },
          context: { client: 'bugzilla' },
        });

        return comments[0].text;
      } catch (error) {
        this.setState({ error });
      }
    }
  );

  fetchBugzilla = (products, components) => {
    const {
      bugzilla: { fetchMore },
    } = this.props;
    const goodFirstPage =
      products.join() in pageCursors.bzGoodFirst
        ? pageCursors.bzGoodFirst[products.join()].nextPage
        : 0;
    const mentoredPage =
      products.join() in pageCursors.bzMentored
        ? pageCursors.bzMentored[products.join()].nextPage
        : 0;

    return fetchMore({
      query: bugsQuery,
      variables: {
        goodFirst: {
          keywords: [GOOD_FIRST_BUG],
          ...BUGZILLA_SEARCH_OPTIONS,
          products,
          components,
        },
        mentored: {
          ...MENTORED_BUG,
          ...BUGZILLA_SEARCH_OPTIONS,
          products,
          components,
        },
        goodFirstPaging: {
          page: goodFirstPage,
          pageSize: BUGZILLA_PAGE_SIZE,
        },
        mentoredPaging: {
          page: mentoredPage,
          pageSize: BUGZILLA_PAGE_SIZE,
        },
      },
      context: {
        client: 'bugzilla',
      },
      updateQuery(previousResult, { fetchMoreResult }) {
        const moreGoodFirstNodes = fetchMoreResult.goodFirst.edges;
        const moreMentoredNodes = fetchMoreResult.mentored.edges;

        pageCursors.bzGoodFirst[products.join()] =
          fetchMoreResult.goodFirst.pageInfo;
        pageCursors.bzMentored[products.join()] =
          fetchMoreResult.mentored.pageInfo;

        if (!moreGoodFirstNodes.length && !moreMentoredNodes) {
          return previousResult;
        }

        return dotProp.set(
          dotProp.set(
            previousResult,
            'goodFirst.edges',
            moreGoodFirstNodes.concat(previousResult.goodFirst.edges)
          ),
          'mentored.edges',
          moreMentoredNodes.concat(previousResult.mentored.edges)
        );
      },
    });
  };

  fetchGithub = searchQuery => {
    const {
      github: { fetchMore },
    } = this.props;
    const endCursor =
      searchQuery in pageCursors.github
        ? pageCursors.github[searchQuery].endCursor
        : null;

    return fetchMore({
      query: githubInfoQuery,
      variables: {
        searchQuery,
        type: 'ISSUE',
        after: endCursor,
      },
      context: {
        client: 'github',
      },
      updateQuery(previousResult, { fetchMoreResult }) {
        const moreNodes = fetchMoreResult.search.nodes;

        pageCursors.github[searchQuery] = fetchMoreResult.search.pageInfo;

        if (!moreNodes.length) {
          return previousResult;
        }

        return dotProp.set(
          previousResult,
          'search.nodes',
          moreNodes.concat(previousResult.search.nodes)
        );
      },
    });
  };

  handleLoad = async () => {
    this.setState({ isNextPageLoading: true });

    const project = projects[this.props.match.params.project];
    const repositories = mergeAll(project.repositories);
    const tagsMapping = tagReposMapping(repositories);

    await Promise.all(
      Object.entries(tagsMapping).map(([tag, repos]) => {
        const searchQuery = [
          repos.map(repo => `repo:${repo}`).join(' '),
          `label:"${tag}"`,
          'state:open',
        ].join(' ');

        return this.fetchGithub(searchQuery);
      })
    );
    const productInfos = getProductsInfoWithoutLabel(project.products);
    const productWithComponentList = productInfos
      ? productInfos
          .filter(product => typeof product !== 'string')
          .reduce((prev, product) => mergeWith(concat, prev, product), {})
      : {};
    const productWithNoComponentList = project.products
      ? project.products.filter(product => typeof product === 'string')
      : [];

    // fetch only the product with component list, since product without
    // component would have been fetched by the initial graphql decorator query
    await Promise.all(
      Object.entries(productWithComponentList).map(([products, components]) =>
        this.fetchBugzilla([products], components)
      )
    );

    if (productWithNoComponentList.length)
      await this.fetchBugzilla(productWithNoComponentList, undefined);

    this.setState({ isNextPageLoading: false });
  };

  render() {
    const { isNextPageLoading, error } = this.state;
    const githubData = this.props.github;
    const bugzillaData = this.props.bugzilla;
    const project = projects[this.props.match.params.project];
    const issues =
      (githubData &&
        githubData.search &&
        uniqBy(
          githubData.search.nodes.map(issue => ({
            project: issue.repository.name,
            summary: {
              title: issue.title,
              url: issue.url,
            },
            tags: issue.labels.nodes.map(node => node.name).sort(),
            lastUpdated: issue.updatedAt,
            assignee: issue.assignees.nodes[0]
              ? issue.assignees.nodes[0].login
              : '-',
            description: issue.body,
            projectLabels: [issue.repository.name],
          })),
          'summary.title'
        )) ||
      [];
    const goodFirstBugs =
      (bugzillaData &&
        bugzillaData.goodFirst &&
        uniqBy(
          bugzillaData.goodFirst.edges
            .map(edge => edge.node)
            .map(bug => ({
              assignee: BUGZILLA_UNASSIGNED.some(email =>
                bug.assignedTo.name.endsWith(email)
              )
                ? '-'
                : bug.assignedTo.name,
              project: bug.component,
              tags: [
                ...(bug.keywords || []),
                ...extractWhiteboardTags(bug.whiteboard),
              ],
              summary: {
                title: bug.summary,
                url: `https://bugzilla.mozilla.org/show_bug.cgi?id=${bug.id}`,
              },
              lastUpdated: bug.lastChanged,
              id: bug.id,
              projectLabels: getProjectLabels(
                this.props.match.params.project,
                bug.product,
                bug.component
              ),
            })),
          'summary.title'
        )) ||
      [];
    const mentoredBugs =
      (bugzillaData &&
        bugzillaData.mentored &&
        uniqBy(
          bugzillaData.mentored.edges
            .map(edge => edge.node)
            .map(bug => ({
              assignee: BUGZILLA_UNASSIGNED.some(email =>
                bug.assignedTo.name.endsWith(email)
              )
                ? '-'
                : bug.assignedTo.name,
              project: bug.component,
              tags: [
                ...(bug.keywords || []),
                ...extractWhiteboardTags(bug.whiteboard),
              ],
              summary: {
                title: bug.summary,
                url: `https://bugzilla.mozilla.org/show_bug.cgi?id=${bug.id}`,
              },
              lastUpdated: bug.lastChanged,
              id: bug.id,
              projectLabels: getProjectLabels(
                this.props.match.params.project,
                bug.product,
                bug.component
              ),
            })),
          'summary.title'
        )) ||
      [];
    const items = uniqBy(
      [...issues, ...goodFirstBugs, ...mentoredBugs],
      'summary.title'
    );

    return (
      <Dashboard title={project.name}>
        {project.introduction && (
          <ProjectIntroductionCard introduction={project.introduction} />
        )}
        {error && <ErrorPanel error={error} />}
        {githubData && githubData.error && (
          <ErrorPanel error={githubData.error} />
        )}
        {bugzillaData && bugzillaData.error && (
          <ErrorPanel error={bugzillaData.error} />
        )}
        {isNextPageLoading && <Spinner />}
        <TasksTable
          onBugInfoClick={this.handleBugInfoClick}
          items={items}
          hasNextPage={hasNextPage(pageCursors)}
          isNextPageLoading={isNextPageLoading}
          onNextPageLoad={this.handleLoad}
        />
      </Dashboard>
    );
  }
}
