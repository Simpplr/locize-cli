const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const rimraf = require('rimraf');
const async = require('async');
const colors = require('colors');
const request = require('request');
const flatten = require('flat');
const cloneDeep = require('lodash.clonedeep');
const gettextToI18next = require('i18next-conv').gettextToI18next;
const csvjson = require('csvjson');
const xlsx = require('xlsx');
const jsyaml = require('js-yaml');
const asr2js = require('android-string-resource/asr2js');
const stringsFile = require('strings-file');
const xliff2js = require('xliff/xliff2js');
const xliff12ToJs = require('xliff/xliff12ToJs');
const targetOfjs = require('xliff/targetOfjs');
const resx2js = require('resx/resx2js');
const ftl2js = require('fluent_conv/ftl2js');
const tmx2js = require('tmexchange/tmx2js');
const getRemoteNamespace = require('./getRemoteNamespace');
const getRemoteLanguages = require('./getRemoteLanguages');
const convertToDesiredFormat = require('./convertToDesiredFormat');
const formats = require('./formats');
const fileExtensionsMap = formats.fileExtensionsMap;
const acceptedFileExtensions = formats.acceptedFileExtensions;
const reversedFileExtensionsMap = formats.reversedFileExtensionsMap;

const getFiles = (srcpath) => {
  return fs.readdirSync(srcpath).filter(function(file) {
    return !fs.statSync(path.join(srcpath, file)).isDirectory();
  }).filter((file) => acceptedFileExtensions.indexOf(path.extname(file)) > -1);
};

const getDirectories = (srcpath) => {
  return fs.readdirSync(srcpath).filter(function(file) {
    return fs.statSync(path.join(srcpath, file)).isDirectory();
  });
};

const convertToFlatFormat = (opt, data, cb) => {
  try {
    if (opt.format === 'json' || opt.format === 'flat') {
      cb(null, flatten(JSON.parse(data.toString())));
      return;
    }
    if (opt.format === 'po' || opt.format === 'gettext') {
      gettextToI18next(opt.referenceLanguage, data.toString())
        .then((ret) => {
          try {
            cb(null, flatten(JSON.parse(ret.toString())));
          } catch (err) { cb(err); }
        }, cb);
      return;
    }
    if (opt.format === 'csv') {
      const options = {
        delimiter: ',',
        quote: '"'
      };
      // https://en.wikipedia.org/wiki/Delimiter-separated_values
      // temporary replace "" with \_\" so we can revert this 3 lines after
      const jsonData = csvjson.toObject(data.toString().replace(/""/g, '\\_\\"'), options);
      data = jsonData.reduce((mem, entry) => {
        if (entry.key && typeof entry[opt.referenceLanguage] === 'string') {
          mem[entry.key.replace(/\\_\\"/g, '"')] = entry[opt.referenceLanguage].replace(/\\_\\"/g, '"');
        }
        return mem;
      }, {});
      cb(null, data);
      return;
    }
    if (opt.format === 'xlsx') {
      const wb = xlsx.read(data, { type: 'buffer' });
      const jsonData = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      data = jsonData.reduce((mem, entry) => {
        if (entry.key && typeof entry[opt.referenceLanguage] === 'string') {
          mem[entry.key] = entry[opt.referenceLanguage];
        }
        return mem;
      }, {});
      cb(null, data);
      return;
    }
    if (opt.format === 'yaml') {
      cb(null, flatten(jsyaml.safeLoad(data)));
      return;
    }
    if (opt.format === 'yaml-rails') {
      const jsObj = jsyaml.safeLoad(data);
      cb(null, flatten(jsObj[Object.keys(jsObj)[0]][Object.keys(jsObj[Object.keys(jsObj)[0]])[0]]));
      return;
    }
    if (opt.format === 'android') {
      asr2js(data.toString(), cb);
      return;
    }
    if (opt.format === 'strings') {
      // CRLF => LF
      data = stringsFile.parse(data.toString().replace(/\r\n/g, '\n'), false);
      cb(null, data);
      return;
    }
    if (opt.format === 'xliff2' || opt.format === 'xliff12') {
      const fn = opt.format === 'xliff12' ? xliff12ToJs : xliff2js;
      fn(data.toString(), (err, res) => {
        if (err) return cb(err);
        targetOfjs(res, cb);
      });
      return;
    }
    if (opt.format === 'resx') {
      resx2js(data.toString(), cb);
      return;
    }
    if (opt.format === 'fluent') {
      const fluentJS = ftl2js(data.toString());
      Object.keys(fluentJS).forEach((prop) => {
        if (fluentJS[prop] && fluentJS[prop].comment) delete fluentJS[prop].comment;
      });
      cb(null, flatten(fluentJS));
      return;
    }
    if (opt.format === 'tmx') {
      tmx2js(data.toString(), (err, jsonData) => {
        if (err) return cb(err);
        const tmxJsRes = jsonData.resources[Object.keys(jsonData.resources)[0]];
        const res = {};
        if (tmxJsRes) {
          Object.keys(tmxJsRes).forEach((k) => {
            res[k] = tmxJsRes[k][opt.referenceLanguage];
          });
        }
        cb(null, res);
      });
      return;
    }
    cb(new Error(`${opt.format} is not a valid format!`));
  } catch (err) { cb(err); }
};

const parseLocalReference = (opt, cb) => {
  if (!opt.dry) mkdirp.sync(path.join(opt.path, opt.languageFolderPrefix + opt.referenceLanguage));

  var files = [];
  try {
    files = getFiles(path.join(opt.path, opt.languageFolderPrefix + opt.referenceLanguage));
  } catch (err) {}
  async.map(files, (file, clb) => {
    fs.readFile(path.join(opt.path, opt.languageFolderPrefix + opt.referenceLanguage, file), (err, data) => {
      if (err) return clb(err);

      if (fileExtensionsMap[path.extname(file)].indexOf(opt.format) < 0) {
        return clb(new Error(`Format mismatch! Found ${fileExtensionsMap[path.extname(file)][0]} but requested ${opt.format}!`));
      }

      convertToFlatFormat(opt, data, (err, content) => {
        if (err) {
          err.message = 'Invalid content for "' + opt.format + '" format!\n' + (err.message || '');
          err.message += '\n' + path.join(opt.path, opt.languageFolderPrefix + opt.referenceLanguage, file);
          return clb(err);
        }

        clb(null, {
          namespace: path.basename(file, path.extname(file)),
          path: path.join(opt.path, opt.languageFolderPrefix + opt.referenceLanguage, file),
          extension: path.extname(file),
          content: content
        });
      });
    });
  }, cb);
};

const getDownloads = (opt, cb) => {
  request({
    method: 'GET',
    json: true,
    url: opt.apiPath + '/download/' + opt.projectId + '/' + opt.version,
    headers: opt.apiKey ? {
      'Authorization': opt.apiKey
    } : undefined
  }, (err, res, obj) => {
    if (err || (obj && (obj.errorMessage || obj.message))) {
      if (err) return cb(err);
      if (obj && (obj.errorMessage || obj.message)) return cb(new Error((obj.errorMessage || obj.message)));
    }
    if (res.statusCode >= 300) return cb(new Error(res.statusMessage + ' (' + res.statusCode + ')'));

    cb(null, obj);
  });
};

const compareNamespace = (local, remote) => {
  const diff = {
    toAdd: [],
    toUpdate: [],
    toRemove: []
  };
  local = local || {};
  remote = remote || {};
  Object.keys(local).forEach((k) => {
    if (!remote[k]) diff.toAdd.push(k);
    if (remote[k] && remote[k] !== local[k]) diff.toUpdate.push(k);
  });
  Object.keys(remote).forEach((k) => {
    if (!local[k]) diff.toRemove.push(k);
  });
  return diff;
};

const compareNamespaces = (opt, localNamespaces, cb) => {
  async.map(localNamespaces, (ns, clb) => {
    getRemoteNamespace(opt, opt.referenceLanguage, ns.namespace, (err, remoteNamespace) => {
      if (err) return clb(err);

      const diff = compareNamespace(ns.content, remoteNamespace);
      ns.diff = diff;
      ns.remoteContent = remoteNamespace;
      clb(null, ns);
    });
  }, cb);
};

const getNamespaceNamesAvailableInReference = (opt, downloads) => {
  var nsNames = [];
  downloads.forEach((d) => {
    const splitted = d.key.split('/');
    const lng = splitted[2];
    const ns = splitted[3];
    if (lng === opt.referenceLanguage) {
      nsNames.push(ns);
    }
  });
  return nsNames;
};

const ensureAllNamespacesInLanguages = (opt, remoteLanguages, downloads) => {
  const namespaces = getNamespaceNamesAvailableInReference(opt, downloads);

  remoteLanguages.forEach((lng) => {
    namespaces.forEach((n) => {
      const found = downloads.find((d) => d.key === `${opt.projectId}/${opt.version}/${lng}/${n}`);
      if (!found) {
        downloads.push({
          key: `${opt.projectId}/${opt.version}/${lng}/${n}`,
          lastModified: '1960-01-01T00:00:00.000Z',
          size: 0,
          url: `${opt.apiPath}/${opt.projectId}/${opt.version}/${lng}/${n}`
        });
      }
    });
  });
};

const downloadAll = (opt, remoteLanguages, omitRef, cb) => {
  if (!cb) {
    cb = omitRef;
    omitRef = false;
  }

  if (!opt.dry) cleanupLanguages(opt, remoteLanguages);

  getDownloads(opt, (err, downloads) => {
    if (err) return cb(err);

    ensureAllNamespacesInLanguages(opt, remoteLanguages, downloads);

    if (omitRef) {
      downloads = downloads.filter((d) => {
        const splitted = d.key.split('/');
        const lng = splitted[d.isPrivate ? 3 : 2];
        return lng !== opt.referenceLanguage;
      });
    }
    async.each(downloads, (download, clb) => {
      const splitted = download.key.split('/');
      const lng = splitted[download.isPrivate ? 3 : 2];
      const namespace = splitted[download.isPrivate ? 4 : 3];
      opt.isPrivate = download.isPrivate;
      getRemoteNamespace(opt, lng, namespace, (err, ns, lastModified) => {
        if (err) return clb(err);

        if (opt.skipEmpty && Object.keys(flatten(ns)).length === 0) {
          return clb(null);
        }

        convertToDesiredFormat(opt, namespace, lng, ns, lastModified, (err, converted) => {
          if (err) {
            err.message = 'Invalid content for "' + opt.format + '" format!\n' + (err.message || '');
            return clb(err);
          }

          if (opt.dry) return clb(null);
          fs.writeFile(path.join(opt.path, opt.languageFolderPrefix + lng, namespace + reversedFileExtensionsMap[opt.format]), converted, clb);
        });
      });
    }, cb);
  });
};

const update = (opt, lng, ns, cb) => {
  var data = {};
  ns.diff.toRemove.forEach((k) => data[k] = null);
  ns.diff.toAdd.forEach((k) => data[k] = ns.content[k]);
  if (opt.updateValues) {
    ns.diff.toUpdate.forEach((k) => data[k] = ns.content[k]);
  }

  if (Object.keys(data).length === 0) return cb(null);

  if (opt.dry) return cb(null);

  request({
    method: 'POST',
    json: true,
    url: opt.apiPath + '/update/' + opt.projectId + '/' + opt.version + '/' + lng + '/' + ns.namespace,
    body: data,
    headers: {
      'Authorization': opt.apiKey
    }
  }, (err, res, obj) => {
    if (err || (obj && (obj.errorMessage || obj.message))) {
      if (err) return cb(err);
      if (obj && (obj.errorMessage || obj.message)) {
        return cb(new Error((obj.errorMessage || obj.message)));
      }
    }
    if (res.statusCode >= 300) {
      return cb(new Error(res.statusMessage + ' (' + res.statusCode + ')'));
    }
    cb(null);
  });
};

const cleanupLanguages = (opt, remoteLanguages) => {
  const dirs = getDirectories(opt.path).filter((dir) => dir.indexOf('.') !== 0);
  dirs.filter((lng) => lng !== opt.referenceLanguage).forEach((lng) => rimraf.sync(path.join(opt.path, opt.languageFolderPrefix + lng)));
  remoteLanguages.forEach((lng) => mkdirp.sync(path.join(opt.path, opt.languageFolderPrefix + lng)));
};

const handleError = (err, cb) => {
  if (!cb && err) {
    console.error(colors.red(err.stack));
    process.exit(1);
  }
  if (cb) cb(err);
};

const sync = (opt, cb) => {
  if (!reversedFileExtensionsMap[opt.format]) {
    return handleError(new Error(`${opt.format} is not a valid format!`));
  }

  if (!opt.dry && opt.clean) rimraf.sync(path.join(opt.path, '*'));
  if (!opt.dry) mkdirp.sync(opt.path);

  getRemoteLanguages(opt, (err, remoteLanguages) => {
    if (err) return handleError(err);

    parseLocalReference(opt, (err, localNamespaces) => {
      if (err) return handleError(err);

      if (!localNamespaces || localNamespaces.length === 0) {
        downloadAll(opt, remoteLanguages, (err) => {
          if (err) return handleError(err);
          if (!cb) console.log(colors.green('FINISHED'));
          if (cb) cb(null);
        });
        return;
      }

      getDownloads(opt, (err, downloads) => {
        if (err) return cb(err);

        opt.isPrivate = downloads[0].isPrivate;

        compareNamespaces(opt, localNamespaces, (err, compared) => {
          if (err) return handleError(err);

          var wasThereSomethingToUpdate = false;
          async.each(compared, (ns, clb) => {
            if (!cb) {
              if (ns.diff.toRemove.length > 0) {
                console.log(colors.red(`removing ${ns.diff.toRemove.length} keys in ${ns.namespace}...`));
                if (opt.dry) console.log(colors.red(`would remove ${ns.diff.toRemove.join(', ')} in ${ns.namespace}...`));
              }
              if (ns.diff.toAdd.length > 0) {
                console.log(colors.green(`adding ${ns.diff.toAdd.length} keys in ${ns.namespace}...`));
                if (opt.dry) console.log(colors.green(`would add ${ns.diff.toAdd.join(', ')} in ${ns.namespace}...`));
              }
              if (opt.updateValues) {
                if (ns.diff.toUpdate.length > 0) {
                  console.log(colors.yellow(`updating ${ns.diff.toUpdate.length} keys in ${ns.namespace}...`));
                  if (opt.dry) console.log(colors.yellow(`would update ${ns.diff.toUpdate.join(', ')} in ${ns.namespace}...`));
                }
              }
              const somethingToUpdate = ns.diff.toAdd.concat(ns.diff.toRemove)/*.concat(ns.diff.toUpdate)*/.length > 0;
              if (!somethingToUpdate) console.log(colors.grey(`nothing to update for ${ns.namespace}`));
              if (!wasThereSomethingToUpdate && somethingToUpdate) wasThereSomethingToUpdate = true;
            }
            update(opt, opt.referenceLanguage, ns, (err) => {
              if (err) return clb(err);
              if (ns.diff.toRemove.length === 0) return clb();
              const nsOnlyRemove = cloneDeep(ns);
              nsOnlyRemove.diff.toAdd = [];
              nsOnlyRemove.diff.toUpdate = [];
              async.each(remoteLanguages, (lng, clb) => update(opt, lng, nsOnlyRemove, clb), clb);
            });
          }, (err) => {
            if (err) return handleError(err);

            if (!cb) console.log(colors.grey('syncing...'));
            setTimeout(() => {
              downloadAll(opt, remoteLanguages, wasThereSomethingToUpdate, (err) => {
                if (err) return handleError(err);
                if (!cb) console.log(colors.green('FINISHED'));
                if (cb) cb(null);
              });
            }, wasThereSomethingToUpdate && !opt.dry ? 5000 : 0);
          }); // wait a bit before downloading... just to have a chance to get the newly published files
        });
      });
    });
  });
};

module.exports = sync;
