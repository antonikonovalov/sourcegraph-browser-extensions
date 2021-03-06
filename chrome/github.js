function main() {
  // Run on first page load
  maybeAnnotatePage();

  // Run on push-state
  //
  // (Hack: we need to listen to GitHub jquery-pjax events using the same instance of jQuery that fires the events)
  var pageScript = document.createElement('script');
  pageScript.innerHTML = '$(document).on("pjax:success", function () { var evt = new Event("PJAX_PUSH_STATE_0923"); document.dispatchEvent(evt); });';
  document.querySelector('body').appendChild(pageScript);
  document.addEventListener('PJAX_PUSH_STATE_0923', function() {
    maybeAnnotatePage();
  });
}

function maybeAnnotatePage() {
  var page = new GitHubPage(document);
  if (page.isValidGitHubPage) {
    if (page.isPrivateGitHubPage) {
      console.log('Sourcegraph extension running (page is private, no data has been sent to sourcegraph.com):', page.info);
    } else {
      console.log('Sourcegraph extension running (page is publicly visible):', page.info);
    }
    page.inject();
  }
}

function GitHubPage(doc) {
  var permalinkElem = doc.querySelector('a.js-permalink-shortcut');
  if (permalinkElem) {
    this.info = parseURL(permalinkElem.href);
  } else {
    this.info = parseURL(document.URL);
  }

  if (!this.info.repoid) {
    return;
  }
  this.doc = doc;
  var info = this.info;
  // If we reach here, it's some sort of GitHub page
  this.isValidGitHubPage = true;

  var fileElem = doc.querySelector('.file-box .file .blob-wrapper');
  if (fileElem && info.repoid && info.branch && info.path) {
    this.isCodePage = true;
  }
  var buttonHeader = doc.querySelector('ul.pagehead-actions');

  if (!doc.querySelector('body.vis-public')) {
    // Short-circuit if the page is private.
    this.isPrivateGitHubPage = true;
    this.inject = function() {
      if (buttonHeader) {
        createSgButton(info.repoid, false);
      }
    }
    return;
  }

  this.inject = function() {
    // inject header button if appropriate
    if (buttonHeader) {
      getRepositoryBuilds(info.repoid, function(builds, status) { // only show search button if repository has been built
        var search = true;
        if (status === 404) {
          // Sourcegraph doesn't yet have this repository, so let's add it.
          addRepository(info.repoid);
          search = false;
        } else if (status !== 200 || !builds || builds.length == 0) {
          console.log('Not adding Sourcegraph links to source code because status:', status);
          search = false;
        }
        createSgButton(info.repoid, search);
      });
    }

    // inject code element if appropriate
    if (this.isCodePage) {
      getAnnotatedCode(info, fileElem, function(fileInfo, status) {
        // If no references are present, don't modify the view
        if (status !== 200 || !fileInfo.FormatResult || fileInfo.FormatResult.NumRefs === 0) {
          // Show button to access most-recently processed build
          getRepositoryBuilds(info.repoid, function(builds, status) {
            if (status === 404) {
              // Sourcegraph doesn't yet have this repository, so let's add it.
              addRepository(info.repoid);
              return;
            } else if (status === 200 && builds && builds.length > 0) {
              // TODO(bliu): this is "commit most recently processed", but it really should be "last processed commit in history"
              var lastAvailableCommit = builds[0].CommitID;

              // If valid builds are present, link to them
              var codeWrapper = doc.querySelector('.blob-wrapper');
              var explain = doc.createElement('div')
              explain.id = "sg-alert";
              explain.innerHTML = '&#x2731; Sourcegraph has not yet processed this file revision. View the <span class="sg-inline-button"><a target="_blank" href="'+urlToFile(info.repoid, lastAvailableCommit, info.path)+'">Last processed revision</a></span>';
              codeWrapper.insertBefore(explain, codeWrapper.firstChild);
            }
          });
          return;
        }

        // Create <tr> per line.
        var html = fileInfo.ContentsString.split("\n").map(function(line, i) {
          var lineno = i + 1;
          return '<tr class="line"><td id="L' + lineno + '" class="blob-num js-line-number" data-line-number=' + lineno + '></td><td id="LC' + lineno + '" class="blob-code js-file-line">' + line + '</td></tr>';
        }).join("");

        // Prepare linked code
        var sgContainer = doc.createElement('table');
        sgContainer.id = 'sg-container';
        sgContainer.classList.add('highlight');
        sgContainer.classList.add('tab-size-8');
        sgContainer.classList.add('js-file-line-container');
        sgContainer.innerHTML = html;

        // Annotate w/ popovers
        var refs = sgContainer.querySelectorAll('a.ref')
        for (var i = 0; i < refs.length; i++) {
          if (!/^https?:\/\//.test(refs[i].getAttribute('href'))) {
            refs[i].href = '<%= url %>' + refs[i].getAttribute('href');
          }
          refs[i].target = '_blank';
          refs[i].classList.add('defn-popover');
        }

        // Replace unlinked code with linked code
        fileElem.appendChild(sgContainer);
        while (fileElem.firstChild && fileElem.firstChild.id != 'sg-container') {
          fileElem.removeChild(fileElem.firstChild);
        }

        sourcegraph_activateDefnPopovers(fileElem);
      });
    }
  };

  function createSgButton(repoid, search) {
    if (search) {
      var sgButtonURL = urlToRepoSearch(repoid, '');
    } else {
      var sgButtonURL = urlToRepo(repoid);
    }
    var sgButton = buttonHeader.querySelector('#sg-button-container');
    if (!sgButton) {
      sgButton = doc.createElement('li');
      sgButton.id = 'sg-button-container';
      buttonHeader.insertBefore(sgButton, buttonHeader.firstChild);
    }
    if (search) {
      var text = "Search code";
    } else {
      var text = "Go to Sourcegraph";
    }
    sgButton.innerHTML = '<a id="sg-search-button" class="minibutton sg-button" target="_blank" href="'+sgButtonURL+'">&#x2731; ' + text + '</a>';
  }

  function getAnnotatedCode(info, codeElem, callback) {
    var url = '<%= url %>/api/repos/' + info.repoid + '@' + info.branch + '/.tree/' + info.path + '?Formatted=true&ContentsAsString=true';
    get(url, callback);
  }

  function getRepositoryBuilds(repo_id, callback) {
    var url = '<%= url %>/api/repos/'+repo_id+'/.builds?Sort=updated_at&Direction=desc&PerPage=5&Succeeded=true';
    get(url, callback);
  }

  function addRepository(repo_id) {
    var url = '<%= url %>/api/repos/'+repo_id;
    var req = new XMLHttpRequest();
    req.open('PUT', url, true);
    req.send();
  }

  function urlToRepo(repo_id) {
    return '<%= url %>/'+escape(repo_id);
  }

  function urlToRepoSearch(repo_id, query) {
    return '<%= url %>/'+escape(repo_id)+'/.search?q='+escape(query);
  }

  function urlToRepoCommit(repo_id, commit_id) {
    return '<%= url %>/'+escape(repo_id)+'@'+escape(commit_id);
  }

  function urlToFile(repo_id, commit_id, path) {
    return urlToRepoCommit(repo_id, commit_id) + '/.tree/' + escape(path);
  }

  function get(url, callback) {
    var req = new  XMLHttpRequest();
    req.onload = function() {
      callback(this.response, this.status);
    }
    req.open('get', url, true);
    req.responseType = 'json';
    req.send();
  }

  function parseURL(url) {
    var m = url.match(/^https:\/\/github\.com\/([^\/#]+)\/([^\/#]+)(?:\/blob\/([^\/#]+)\/([^#]+))?(?:#[^\/]*)?/);
    if (m) {
      var owner = m[1], name = m[2], branch = m[3], path = m[4];
      if (!owner || !name) return;
      return {
        repoid: 'github.com/' + owner + '/' + name,
        owner: owner,
        name: name,
        branch: branch,
        path: path,
      };
    }
  }
}

main();
