from google.appengine.ext import webapp
from google.appengine.ext.webapp.util import run_wsgi_app

class InjectionHandler(webapp.RequestHandler):
    def get(self):
        self.redirect("http://example.com", True)

application = webapp.WSGIApplication([('/injection', InjectionHandler)])

def main():
    run_wsgi_app(application)

if __name__ == "__main__":
    main()