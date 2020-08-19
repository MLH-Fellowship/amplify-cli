import * as fs from 'fs-extra';
import * as path from 'path';
import chalk from 'chalk';
import _ from 'lodash';
import { print } from './print';
import { hashElement } from 'folder-hash';
import { getEnvInfo } from './get-env-info';
import { CLOUD_INITIALIZED, CLOUD_NOT_INITIALIZED, getCloudInitStatus } from './get-cloud-init-status';
import { ServiceName as FunctionServiceName, hashLayerResource } from 'amplify-category-function';
import { pathManager, stateManager, $TSMeta, $TSAny } from 'amplify-cli-core';
import { readJsonFile } from require('./read-json-file');
const { CloudFormation } = require('aws-sdk');

async function isBackendDirModifiedSinceLastPush(resourceName, category, lastPushTimeStamp, isLambdaLayer = false) {
  // Pushing the resource for the first time hence no lastPushTimeStamp
  if (!lastPushTimeStamp) {
    return false;
  }

  const localBackendDir = path.normalize(path.join(pathManager.getBackendDirPath(), category, resourceName));

  const cloudBackendDir = path.normalize(path.join(pathManager.getCurrentCloudBackendDirPath(), category, resourceName));

  if (!fs.existsSync(localBackendDir)) {
    return false;
  }

  const hashingFunc = isLambdaLayer ? hashLayerResource : getHashForResourceDir;

  const localDirHash = await hashingFunc(localBackendDir);
  const cloudDirHash = await hashingFunc(cloudBackendDir);

  return localDirHash !== cloudDirHash;
}

function getHashForResourceDir(dirPath) {
  const options = {
    folders: { exclude: ['.*', 'node_modules', 'test_coverage', 'dist', 'build'] },
  };

  return hashElement(dirPath, options).then(result => result.hash);
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function filterResources(resources, filteredResources) {
  if (!filteredResources) {
    return resources;
  }

  resources = resources.filter(resource => {
    let common = false;
    for (let i = 0; i < filteredResources.length; ++i) {
      if (filteredResources[i].category === resource.category && filteredResources[i].resourceName === resource.resourceName) {
        common = true;
        break;
      }
    }
    return common;
  });

  return resources;
}

// ! This function has the same body as a function with a similar name on `amplify-provider-awscloudformation/src/aws-cfn.js`, this can probably be refactored later on
function replaceTagVars(tagsArr, tagVarMetadata) {
  const replaceWith = {
    '{project-name}': tagVarMetadata.name,
    '{project-env}': tagVarMetadata.env,
    '{cli-version}': tagVarMetadata.cli,
  };

  return tagsArr.map(tagObj => ({
    ...tagObj,
    Value: tagObj['Value'].replace(/{project-name}|{project-env}|{cli-version}/g, function(matched) {
      return replaceWith[matched];
    }),
  }));
}

// {project-name} -> tags-project
// tags-project

// We are assuming that if they are not equal, it means that the user haas changed the tags locally
// Runs O(n^2) time at worst, but I think it's the easiest way to do so
// Feel free to corect me if I'm wrong
// ? Not sure if this is the best name for it
// ? Decided to have it as a seperate function, since it can easily be used on other situations, since you can't directly compare the key/value pairs by directly grabbing from the cloud and the local file (they aren't in the same order)
// ! Check edge case if a certain Key from one tag in one array is not found on the second array passed
function haveChangedKeyValuePairs(arr1, arr2) {
  let changed = false;

  // Iterate through each key-value pair from the first array
  arr1.forEach(currObj => {
    // Grab the key-value pair from the second array that matches with the "Key" field from the first array
    const otherTag = arr2.find(obj => obj['Key'] === currObj['Key']);

    // If a tag wasn't found it means that tags changed either on the cloud or locally
    if (!otherTag) {
      changed = true;
    } else {
      // Now that we know they have the same key, we check their values - if they don't have the same value, return false
      if (currObj['Value'] !== otherTag['Value']) changed = true;
    }
  });

  // Will return true if all key-value pairs are the same
  return changed;
}

async function getCloudTags(amplifyMeta) {
  const meta = amplifyMeta.providers.awscloudformation;
  const service = new CloudFormation({ region: meta.Region });
  const cloudStackInfo = (await service.describeStacks({ StackName: meta.StackName }).promise()).Stacks.find(
    stack => stack.StackName === meta.StackName,
  );

  return cloudStackInfo.Tags;
}

async function checkChangesInTags(tagVarMetadata) {
  // Getting the current tags from the local tags.json file
  const localAmplifyTagsPath = pathManager.getTagsConfigFilePath();
  const localAmplifyTags = readJsonFile(localAmplifyTagsPath);

  const amplifyMetaFilePath = pathManager.getAmplifyMetaFilePath();
  const amplifyMeta = readJsonFile(amplifyMetaFilePath);

  // Getting current tags pushed to the cloud
  const cloudTags = await getCloudTags(amplifyMeta);

  // If the local tags contain variables, replace them with the real values
  // ? Check edge case where user could potentially have an updated cli version that differs from the currently pussed {cli-version} value
  const cleanedLocalAmplifyTags = replaceTagVars(localAmplifyTags, tagVarMetadata);

  // Compare each key-value pair from both sides and check if there have been changes
  return haveChangedKeyValuePairs(cleanedLocalAmplifyTags, cloudTags);
}

function getAllResources(amplifyMeta, category, resourceName, filteredResources) {
  let resources: any[] = [];

  Object.keys(amplifyMeta).forEach(categoryName => {
    const categoryItem = amplifyMeta[categoryName];
    Object.keys(categoryItem).forEach(resource => {
      amplifyMeta[categoryName][resource].resourceName = resource;
      amplifyMeta[categoryName][resource].category = categoryName;
      resources.push(amplifyMeta[categoryName][resource]);
    });
  });

  resources = filterResources(resources, filteredResources);

  if (category !== undefined && resourceName !== undefined) {
    // Create only specified resource in the cloud
    resources = resources.filter(resource => resource.category === category && resource.resourceName === resourceName);
  }

  if (category !== undefined && !resourceName) {
    // Create all the resources for the specified category in the cloud
    resources = resources.filter(resource => resource.category === category);
  }

  return resources;
}

function getResourcesToBeCreated(amplifyMeta, currentamplifyMeta, category, resourceName, filteredResources) {
  let resources: any[] = [];

  Object.keys(amplifyMeta).forEach(categoryName => {
    const categoryItem = amplifyMeta[categoryName];
    Object.keys(categoryItem).forEach(resource => {
      if (
        (!amplifyMeta[categoryName][resource].lastPushTimeStamp ||
          !currentamplifyMeta[categoryName] ||
          !currentamplifyMeta[categoryName][resource]) &&
        categoryName !== 'providers'
      ) {
        amplifyMeta[categoryName][resource].resourceName = resource;
        amplifyMeta[categoryName][resource].category = categoryName;
        resources.push(amplifyMeta[categoryName][resource]);
      }
    });
  });

  resources = filterResources(resources, filteredResources);

  if (category !== undefined && resourceName !== undefined) {
    // Create only specified resource in the cloud
    resources = resources.filter(resource => resource.category === category && resource.resourceName === resourceName);
  }

  if (category !== undefined && !resourceName) {
    // Create all the resources for the specified category in the cloud
    resources = resources.filter(resource => resource.category === category);
  }

  // Check for dependencies and add them

  for (let i = 0; i < resources.length; ++i) {
    if (resources[i].dependsOn && resources[i].dependsOn.length > 0) {
      for (let j = 0; j < resources[i].dependsOn.length; ++j) {
        const dependsOnCategory = resources[i].dependsOn[j].category;
        const dependsOnResourcename = resources[i].dependsOn[j].resourceName;
        if (
          !amplifyMeta[dependsOnCategory][dependsOnResourcename].lastPushTimeStamp ||
          !currentamplifyMeta[dependsOnCategory] ||
          !currentamplifyMeta[dependsOnCategory][dependsOnResourcename]
        ) {
          resources.push(amplifyMeta[dependsOnCategory][dependsOnResourcename]);
        }
      }
    }
  }

  return _.uniqWith(resources, _.isEqual);
}

function getResourcesToBeDeleted(amplifyMeta, currentamplifyMeta, category, resourceName, filteredResources) {
  let resources: any[] = [];

  Object.keys(currentamplifyMeta).forEach(categoryName => {
    const categoryItem = currentamplifyMeta[categoryName];
    Object.keys(categoryItem).forEach(resource => {
      if (!amplifyMeta[categoryName] || !amplifyMeta[categoryName][resource]) {
        currentamplifyMeta[categoryName][resource].resourceName = resource;
        currentamplifyMeta[categoryName][resource].category = categoryName;

        resources.push(currentamplifyMeta[categoryName][resource]);
      }
    });
  });

  resources = filterResources(resources, filteredResources);

  if (category !== undefined && resourceName !== undefined) {
    // Deletes only specified resource in the cloud
    resources = resources.filter(resource => resource.category === category && resource.resourceName === resourceName);
  }

  if (category !== undefined && !resourceName) {
    // Deletes all the resources for the specified category in the cloud
    resources = resources.filter(resource => resource.category === category);
  }

  return resources;
}

async function getResourcesToBeUpdated(amplifyMeta, currentamplifyMeta, category, resourceName, filteredResources) {
  let resources: any[] = [];

  await asyncForEach(Object.keys(amplifyMeta), async categoryName => {
    const categoryItem = amplifyMeta[categoryName];
    await asyncForEach(Object.keys(categoryItem), async resource => {
      if (currentamplifyMeta[categoryName]) {
        if (currentamplifyMeta[categoryName][resource] !== undefined && amplifyMeta[categoryName][resource] !== undefined) {
          const isLambdaLayer = amplifyMeta[categoryName][resource].service === FunctionServiceName.LambdaLayer;
          const backendModified = await isBackendDirModifiedSinceLastPush(
            resource,
            categoryName,
            currentamplifyMeta[categoryName][resource].lastPushTimeStamp,
            isLambdaLayer,
          );

          if (backendModified) {
            amplifyMeta[categoryName][resource].resourceName = resource;
            amplifyMeta[categoryName][resource].category = categoryName;
            resources.push(amplifyMeta[categoryName][resource]);
          }
        }
      }
    });
  });

  resources = filterResources(resources, filteredResources);

  if (category !== undefined && resourceName !== undefined) {
    resources = resources.filter(resource => resource.category === category && resource.resourceName === resourceName);
  }

  if (category !== undefined && !resourceName) {
    resources = resources.filter(resource => resource.category === category);
  }

  return resources;
}

async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; ++index) {
    await callback(array[index], index, array);
  }
}

export async function getResourceStatus(category?, resourceName?, providerName?, filteredResources?) {
  const amplifyProjectInitStatus = getCloudInitStatus();
  let amplifyMeta: $TSAny;
  let currentamplifyMeta: $TSMeta = {};

  if (amplifyProjectInitStatus === CLOUD_INITIALIZED) {
    amplifyMeta = stateManager.getMeta();
    currentamplifyMeta = stateManager.getCurrentMeta();
  } else if (amplifyProjectInitStatus === CLOUD_NOT_INITIALIZED) {
    amplifyMeta = stateManager.getBackendConfig();
  } else {
    const error = new Error(
      "You are not working inside a valid Amplify project.\nUse 'amplify init' in the root of your app directory to initialize your project, or 'amplify pull' to pull down an existing project.",
    );

    error.name = 'NotInitialized';
    error.stack = undefined;

    throw error;
  }

  let resourcesToBeCreated: any = getResourcesToBeCreated(amplifyMeta, currentamplifyMeta, category, resourceName, filteredResources);
  let resourcesToBeUpdated: any = await getResourcesToBeUpdated(amplifyMeta, currentamplifyMeta, category, resourceName, filteredResources);
  let resourcesToBeDeleted: any = getResourcesToBeDeleted(amplifyMeta, currentamplifyMeta, category, resourceName, filteredResources);

  let allResources: any = getAllResources(amplifyMeta, category, resourceName, filteredResources);

  resourcesToBeCreated = resourcesToBeCreated.filter(resource => resource.category !== 'provider');

  if (providerName) {
    resourcesToBeCreated = resourcesToBeCreated.filter(resource => resource.providerPlugin === providerName);
    resourcesToBeUpdated = resourcesToBeUpdated.filter(resource => resource.providerPlugin === providerName);
    resourcesToBeDeleted = resourcesToBeDeleted.filter(resource => resource.providerPlugin === providerName);
    allResources = allResources.filter(resource => resource.providerPlugin === providerName);
  }

  return {
    resourcesToBeCreated,
    resourcesToBeUpdated,
    resourcesToBeDeleted,
    allResources,
  };
}

export async function showResourceTable(category, resourceName, filteredResources) {
  const amplifyProjectInitStatus = getCloudInitStatus();
  if (amplifyProjectInitStatus === CLOUD_INITIALIZED) {
    const { envName } = getEnvInfo();

    print.info('');
    print.info(`${chalk.green('Current Environment')}: ${envName}`);
    print.info('');
  }

  const { resourcesToBeCreated, resourcesToBeUpdated, resourcesToBeDeleted, allResources } = await getResourceStatus(
    category,
    resourceName,
    undefined,
    filteredResources,
  );

  let noChangeResources = _.differenceWith(allResources, resourcesToBeCreated.concat(resourcesToBeUpdated), _.isEqual);
  noChangeResources = noChangeResources.filter(resource => resource.category !== 'providers');

  const createOperationLabel = 'Create';
  const updateOperationLabel = 'Update';
  const deleteOperationLabel = 'Delete';
  const noOperationLabel = 'No Change';
  const tableOptions = [['Category', 'Resource name', 'Operation', 'Provider plugin']];
  for (let i = 0; i < resourcesToBeCreated.length; ++i) {
    tableOptions.push([
      capitalize(resourcesToBeCreated[i].category),
      resourcesToBeCreated[i].resourceName,
      createOperationLabel,
      resourcesToBeCreated[i].providerPlugin,
    ]);
  }
  for (let i = 0; i < resourcesToBeUpdated.length; ++i) {
    tableOptions.push([
      capitalize(resourcesToBeUpdated[i].category),
      resourcesToBeUpdated[i].resourceName,
      updateOperationLabel,
      resourcesToBeUpdated[i].providerPlugin,
    ]);
  }
  for (let i = 0; i < resourcesToBeDeleted.length; ++i) {
    tableOptions.push([
      capitalize(resourcesToBeDeleted[i].category),
      resourcesToBeDeleted[i].resourceName,
      deleteOperationLabel,
      resourcesToBeDeleted[i].providerPlugin,
    ]);
  }
  for (let i = 0; i < noChangeResources.length; ++i) {
    tableOptions.push([
      capitalize(noChangeResources[i].category),
      noChangeResources[i].resourceName,
      noOperationLabel,
      noChangeResources[i].providerPlugin,
    ]);
  }

  const { table } = print;

  table(tableOptions, { format: 'markdown' });

  const changedResourceCount = resourcesToBeCreated.length + resourcesToBeUpdated.length + resourcesToBeDeleted.length;
  return changedResourceCount;
}
