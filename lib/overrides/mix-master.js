(function(jQuery) {
  "use strict";

  var $ = jQuery;

  var uprootableClass = "webxray-uprootable-element";

  function NullTransitionEffectManager() {
    return {
      enableDuring: function enableDuring(fn) { fn(); }
    };
  }

  function TransitionEffectManager(commandManager) {
    var isEnabled = false;

    commandManager.on('command-created', function(cmd) {
      cmd.on('before-replace', function before(elementToReplace) {
        if (!isEnabled)
          return;
        var overlay = $(elementToReplace).overlay();
        cmd.on('after-replace', function after(newContent) {
          cmd.removeListener('after-replace', after);
          overlay.applyTagColor(newContent, 0.25)
                 .resizeToAndFadeOut(newContent);
        });
      });
    });

    return {
      enableDuring: function enableDuring(fn) {
        if (!isEnabled) {
          isEnabled = true;
          fn();
          isEnabled = false;
        } else
          fn();
      }
    };
  }

  function MixMaster(options) {
    var hud = options.hud;
    var focused = options.focusedOverlay;
    var commandManager = options.commandManager;
    var l10n = Localized.get;
    var dialogPageMods = null;
    var transitionEffects;

    if (options.disableTransitionEffects)
      transitionEffects = new NullTransitionEffectManager();
    else
      transitionEffects = new TransitionEffectManager(commandManager);

    function updateStatus(verb, command) {
      var span = $('<span></span>');
      span.text(verb + ' ' + command.name + '.');
      $(hud.overlay).empty().append(span);
    }

    function runCommand(name, options) {
      focused.unfocus();
      var command = commandManager.run(name, options);
      updateStatus(l10n('command-manager:executed'), command);
    }

    var self = {
      undo: function() {
        if (commandManager.canUndo()) {
          focused.unfocus();
          transitionEffects.enableDuring(function() {
            updateStatus(l10n('command-manager:undid'),
                         commandManager.undo());
          });
        } else {
          var msg = l10n('cannot-undo-html');
          $(hud.overlay).html(msg);
        }
      },
      redo: function() {
        if (commandManager.canRedo()) {
          focused.unfocus();
          transitionEffects.enableDuring(function() {
            updateStatus(l10n('command-manager:redid'),
                         commandManager.redo());
          });
        } else {
          var msg = l10n('cannot-redo-html');
          $(hud.overlay).html(msg);
        }
      },
      htmlToJQuery: function htmlToJQuery(html) {
        if (html === '' || typeof(html) != 'string')
          return $('<span></span>');
        if (html[0] != '<')
          html = '<span>' + html + '</span>';
        return $(html);
      },
      deleteFocusedElement: function deleteFocusedElement() {
        var elementToDelete = focused.getPrimaryElement();
        if (elementToDelete) {
          if ($(elementToDelete).is('html, body')) {
            var msg = l10n('too-big-to-change');
            jQuery.transparentMessage($('<div></div>').text(msg));
            return;
          }
          // Replacing the element with a zero-length invisible
          // span is a lot easier than actually deleting the element,
          // since it allows us to place a "bookmark" in the DOM
          // that can easily be undone if the user wishes.
          var placeholder = $('<span class="webxray-deleted"></span>');
          transitionEffects.enableDuring(function() {
            runCommand("ReplaceWithCmd", {
              name: l10n('deletion'),
              elementToReplace: elementToDelete,
              newContent: placeholder
            });
          });
        }
      },
      infoForFocusedElement: function infoForFocusedElement(open) {
        var element = focused.getPrimaryElement();
        open = open || window.open;
        if (element) {
          var url = 'https://developer.mozilla.org/en/HTML/Element/' +
                    element.nodeName.toLowerCase();
          open(url, 'info');
        }
      },
      replaceElement: function(originalElement, elementToReplace, html, saveState) {
        var newContent = self.htmlToJQuery(html);

        // Use saveState to determine whether or not this action should be put on the
        // undo/redo stack.
        if (saveState) {

          // To avoid tapping too far down the Command rabbit-hole, just put the
          // original element back, and apply new changes on top of it.
          $(elementToReplace).replaceWith(originalElement);

          runCommand("ReplaceWithCmd", {
            name: l10n('replacement'),
            elementToReplace: originalElement,
            newContent: newContent
          });
        }
        else {
          $(elementToReplace).replaceWith(newContent);
        }
        return newContent;
      },
      setDialogPageMods: function(mods) {
        dialogPageMods = mods;
      },
      replaceFocusedElementWithDialog: function(options) {
        var input = options.input;
        var dialogURL = options.dialogURL;
        var sendFullDocument = options.sendFullDocument;
        var MAX_HTML_LENGTH = 5000;
        var focusedElement =  focused.getPrimaryElement();
        if (!focusedElement)
          return;

        // We need to remove any script tags in the element now, or else
        // we'll likely re-execute them.
        $(focusedElement).find("script").remove();

        var focusedHTML = $(focusedElement).outerHtml();

        if ($(focusedElement).is('html, body')) {
          var msg = l10n("too-big-to-change");
          jQuery.transparentMessage($('<div></div>').text(msg));
          return;
        }

        if (focusedHTML.length === 0 ||
            focusedHTML.length > MAX_HTML_LENGTH) {
          var tagName = focusedElement.nodeName.toLowerCase();
          var nmsg = l10n("too-big-to-remix-html").replace("${tagName}",
                                                          tagName);
          jQuery.transparentMessage($(nmsg));
          return;
        }

        if (sendFullDocument) {
          $(focusedElement).addClass(uprootableClass);
          $(document).uprootIgnoringWebxray(function (html) {
            begin({
              html: html,
              selector: "."+uprootableClass
            });
          });
        } else {
          begin(focusedHTML);
        }

        function begin(startHTML) {
          focused.unfocus();

          var originalElement = focusedElement;

          jQuery.morphElementIntoDialog({
            input: input,
            body: options.body,
            url: dialogURL,
            element: focusedElement,
            onLoad: function(dialog) {
              dialog.iframe.postMessage(JSON.stringify({
                startHTML: startHTML,
                mods: dialogPageMods,
                baseURI: document.location.href
              }), "*");
              dialog.iframe.fadeIn();
              dialog.iframe.bind("message", function onMessage(event, data) {
                try {
                  data = JSON.parse(data);

                  if (data.msg === "ok") {
                    // The dialog may have decided to replace all our spaces
                    // with non-breaking ones, so we'll undo that.
                    var html = data.endHTML.replace(/\u00a0/g, " ");
                    var newContent = self.replaceElement(originalElement, focusedElement, html, data.finished);
                    focusedElement = newContent[0];

                    if(data.finished) {
                      newContent.addClass(uprootableClass);
                      jQuery.morphDialogIntoElement({
                        dialog: dialog,
                        input: input,
                        element: newContent,
                        finished: data.finished,
                        canceled: data.canceled,
                        onDone: function() {
                          newContent.reallyRemoveClass(uprootableClass);
                          window.postMessage("goggles-edit-finished", "*");
                        }
                      });
                    } else {
                      window.postMessage("goggles-edit-start", "*");
                    }
                  } else {
                    // TODO: Re-focus previously focused elements?
                    $(focusedElement).reallyRemoveClass(uprootableClass);
                    dialog.close();
                  }
                } catch (e) {
                  console.error("postmessage was not valid JSON");
                }
              });
            }
          });
        }
      }
    };
    return self;
  }

  jQuery.extend({mixMaster: MixMaster});
})(jQuery);
